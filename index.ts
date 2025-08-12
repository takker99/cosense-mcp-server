import { patch } from "@cosense/std/websocket";
import { listProjects } from "@cosense/std/rest";
import type { FoundPage, Page } from "@cosense/types/rest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isErr, unwrapErr } from "option-t/plain_result";
import z from "zod";
import { getConfig } from "./config.ts";
import denoJson from "./deno.json" with { type: "json" };
import { get as getPage } from "@cosense/std/unstable-api/pages/project/title";
import { get as listPages } from "@cosense/std/unstable-api/pages/project";
import { get as searchForPages } from "@cosense/std/unstable-api/pages/project/search/query";
import { unwrapOk } from "option-t/plain_result/result";
import { lightFormat } from "date-fns/lightFormat";

function foundPageToText({ title, words, lines }: FoundPage): string {
  return [
    `Page title: ${title}`,
    `Matched words: ${words.join(", ")}`,
    `Surrounding lines:`,
    lines.join("\n"),
  ].join("\n");
}

function pageToText(page: Page): string {
  console.log(page.relatedPages);
  const text = `
${page.lines.map((line) => line.text).join("\n")}

# Related Pages
## 1-hop links
${page.relatedPages.links1hop.map((page) => page.title).join("\n")}

## 2-hop links
${page.relatedPages.links2hop.map((page) => page.title).join("\n")}

## external links
${page.relatedPages.projectLinks1hop.map((page) => page.title).join("\n")}
`;
  return text;
}

const makeCosenseURI = (project: string, title: string): string =>
  `cosense://${project}/${title}`;
const parseCosenseURI = (
  uri: string,
): { project: string; title: string } | undefined => {
  const match = uri.match(/^cosense:\/\/([^\/]+)\/(.+)$/);
  if (!match) return undefined;
  const [, project, title] = match;
  return { project, title };
};

if (import.meta.main) {
  const config = getConfig();

  const server = new McpServer({
    name: "cosense-mcp-server",
    version: denoJson.version,
  });

  // 低レベルAPIを使用してリソース機能を手動で設定
  server.server.registerCapabilities({
    resources: {
      listChanged: true,
    },
  });

  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    async (request) => {
      const cursor = request.params?.cursor;
      let skip = 0;
      if (cursor) {
        skip = parseInt(cursor);
        if (isNaN(skip)) {
          throw new Error(`Invalid cursor: ${cursor}`);
        }
      }
      const res = await listPages(config.projectName, {
        sid: config.cosenseSid,
        skip,
      });
      if (!res.ok) {
        throw new Error(`Failed to list pages: ${(await res.json()).message}`);
      }
      const { pages, count } = await res.json();
      return {
        resources: pages.map((page) => ({
          uri: makeCosenseURI(config.projectName, page.title),
          name: page.title,
          description: page.descriptions.join("\n"),
          mimeType: "text/plain",
        })),
        nextCursor: skip + pages.length < count
          ? `${skip + pages.length}`
          : undefined,
      };
    },
  );

  server.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request) => {
      const { project, title } = parseCosenseURI(request.params.uri) ?? {};

      if (!project || !title) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${request.params.uri} not found`,
        );
      }

      const res = await getPage(project, decodeURIComponent(title), {
        sid: config.cosenseSid,
      });
      if (!res.ok) {
        throw new Error(`Error: ${(await res.json()).message}`);
      }
      return {
        contents: [{
          uri: request.params.uri,
          text: pageToText(await res.json()),
        }],
      };
    },
  );

  server.registerTool("get_page", {
    description:
      "Get a page with the specified title from the Cosense project.\nThis includes not only the page content but also related pages.",
    inputSchema: {
      project: z.string().default(config.projectName).describe(
        "Cosense project name",
      ),
      title: z.string().describe("Title of the page"),
    },
  }, async ({ project, title }) => {
    const projectName = project;
    console.debug(`Fetching page: ${projectName}/${title}`);
    const res = await getPage(projectName, title, {
      sid: config.cosenseSid,
    });
    if (!res.ok) {
      const { message } = await res.json();
      return {
        content: [
          {
            type: "text",
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: pageToText(await res.json()) }] };
  });

  server.registerTool("list_project", {
    description: "List all Cosense projects you are a member of.",
  }, async () => {
    const res = await listProjects([], { sid: config.cosenseSid });

    if (isErr(res)) {
      const { name, message } = unwrapErr(res);
      return {
        content: [{ type: "text", text: `${name}: ${message}` }],
        isError: true,
      };
    }
    const { projects } = unwrapOk(res);
    return {
      content: projects.map((project) => ({
        type: "text",
        text:
          `Name: ${project.name}\nDisplay name: ${project.displayName}\nId: ${project.id}\nLast updated: ${
            lightFormat(new Date(project.updated * 1000), "yyyy-MM-dd HH:mm:ss")
          }\n${project.publicVisible ? "Public" : "Private"} project\nYou are${
            project.isMember ? "" : "n't"
          } a member of this project.`,
      })),
    };
  });

  server.registerTool(
    "list_pages",
    {
      description: "List latest 100 Cosense pages in the resources.",
      inputSchema: {
        project: z.string().default(config.projectName).describe(
          "Cosense project name",
        ),
      },
      outputSchema: {
        error: z.object({
          name: z.string().describe("Error name"),
          message: z.string().describe("Error message"),
        }).optional(),
        pages: z.array(
          z.object({
            id: z.string().describe("Cosense page ID"),
            title: z.string().describe("Title of the page"),
            image: z.union([z.string(), z.null()]).describe(
              "Thumbnail URL of the page, if available",
            ),
            descriptions: z.array(z.string()).describe(
              "The less than 6 head lines of the page",
            ),
            pin: z.number().describe("Pin at the top page if it is not 0"),
            user: z.object({
              id: z.string().describe("User ID of the page creator"),
            }),
            lastUpdateUser: z.object({
              id: z.string().describe("User ID of the last updater"),
            }),
            created: z.number().describe("Creation timestamp of the page"),
            updated: z.number().describe("Last updated timestamp of the page"),
            accessed: z.number().describe(
              "Last accessed timestamp of the page",
            ),
            views: z.number().describe("Number of views of the page"),
            linked: z.number().describe("Number of linked pages"),
            linesCount: z.number().describe("Number of lines in the page"),
            charsCount: z.number().describe(
              "Number of characters in the page",
            ),
            helpfeels: z.array(z.string()).describe(
              "The list of helpfeel notations in the page",
            ),
          }),
        ).optional(),
        isError: z.boolean(),
      },
    },
    async ({ project }) => {
      const projectName = project;
      const res = await listPages(projectName, {
        sid: config.cosenseSid,
      });
      if (!res.ok) {
        const error = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
          structuredContent: {
            error,
            isError: true,
          },
        };
      }
      const { pages } = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(pages, null, 2) }],
        structuredContent: {
          pages,
          isError: false,
        },
      };
    },
  );

  server.registerTool(
    "search_pages",
    {
      description:
        "Search for pages containing the specified query string in the Cosense project.",
      inputSchema: {
        project: z.string().default(config.projectName).describe(
          "Cosense project name",
        ),
        query: z.string().describe("Search query string (space separated)"),
      },
    },
    async (args) => {
      const { project, query } = args;
      const projectName = project;
      const res = await searchForPages(projectName, query, {
        sid: config.cosenseSid,
      });
      if (!res.ok) {
        const { message } = await res.json();
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
      const searchResult = await res.json();

      const headerText = [
        `Search result for "${query}":`,
        `Found ${searchResult.count} pages.`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: headerText,
          },
          ...searchResult.pages.map((page) => ({
            type: "text" as const,
            text: foundPageToText(page),
          })),
        ],
      };
    },
  );

  server.registerTool(
    "insert_lines",
    {
      description:
        "Insert lines after the specified target line in a Cosense page. If the target line is not found, append to the end of the page.",
      inputSchema: {
        project: z.string().default(config.projectName).describe(
          "Cosense project name",
        ),
        pageTitle: z.string().describe("Title of the page to modify"),
        targetLineText: z.string().describe(
          "Text of the line after which to insert new content. If not found, content will be appended to the end.",
        ),
        text: z.string().describe(
          "Text to insert. If you want to insert multiple lines, use \\n for line breaks.",
        ),
      },
    },
    async (args, _context) => {
      const { project, pageTitle, targetLineText, text } = args;
      const projectName = project;
      const result = await patch(
        projectName,
        pageTitle,
        (lines) => {
          let index = lines.findIndex((line) => line.text === targetLineText);
          index = index < 0 ? lines.length : index;
          const linesText = lines.map((line) => line.text);
          return [
            ...linesText.slice(0, index + 1),
            ...text.split("\n"),
            ...linesText.slice(index + 1),
          ];
        },
        { sid: config.cosenseSid },
      );
      if (result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Successfully inserted lines.`,
            },
          ],
        };
      } else {
        throw unwrapErr(result);
      }
    },
  );

  server.registerTool(
    "write_page",
    {
      description:
        "Rewrite the entire content of a Cosense page with new content. This tool supports LLM sampling for flexible page editing with validation and retry capabilities.",
      inputSchema: {
        project: z.string().default(config.projectName).describe(
          "Cosense project name. Must be in the list of editable projects.",
        ),
        pageTitle: z.string().describe("Title of the page to rewrite"),
        newContent: z.string().describe(
          "New content for the page. Use \\n for line breaks.",
        ),
        allowTitleChange: z.boolean().default(false).describe(
          "Whether to allow changing the page title. Default is false for safety.",
        ),
        retryLimit: z.number().default(config.defaultRetryLimit).describe(
          `Maximum number of retry attempts if validation fails. Default is ${config.defaultRetryLimit}.`,
        ),
      },
    },
    async (args, _context) => {
      const { project, pageTitle, newContent, allowTitleChange, retryLimit } =
        args;
      const projectName = project;

      // Validate that the project is editable
      if (!config.editableProjects.includes(projectName)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Project '${projectName}' is not in the list of editable projects. Editable projects: ${
                  config.editableProjects.join(", ")
                }`,
            },
          ],
          isError: true,
        };
      }

      // Validate retry limit
      if (retryLimit < 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Retry limit must be non-negative.",
            },
          ],
          isError: true,
        };
      }

      // Split new content into lines
      const newLines = newContent.split("\n");

      // Check if title change is attempted but not allowed
      if (
        !allowTitleChange && newLines.length > 0 && newLines[0] !== pageTitle
      ) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Title change detected but not allowed. Current title: '${pageTitle}', New first line: '${
                  newLines[0]
                }'. Set allowTitleChange to true if you want to change the title.`,
            },
          ],
          isError: true,
        };
      }

      let lastError: string | null = null;
      let attempts = 0;
      const maxAttempts = retryLimit + 1;

      while (attempts < maxAttempts) {
        attempts++;

        try {
          const result = await patch(
            projectName,
            pageTitle,
            (_lines) => {
              // Return the new content as an array of lines
              return newLines;
            },
            { sid: config.cosenseSid },
          );

          if (result.ok) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Successfully rewrote page '${pageTitle}' in project '${projectName}' (attempt ${attempts}/${maxAttempts}).`,
                },
              ],
            };
          } else {
            const error = unwrapErr(result);
            lastError = error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error);
            if (attempts < maxAttempts) {
              console.log(
                `Write attempt ${attempts} failed, retrying...`,
                lastError,
              );
              continue;
            }
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempts < maxAttempts) {
            console.log(
              `Write attempt ${attempts} failed with exception, retrying...`,
              lastError,
            );
            continue;
          }
        }
      }

      // All retries exhausted
      return {
        content: [
          {
            type: "text",
            text:
              `Error: Failed to rewrite page after ${maxAttempts} attempts. Last error: ${
                lastError || "Unknown error"
              }`,
          },
        ],
        isError: true,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
