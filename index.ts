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
    },
    async ({ project }) => {
      const projectName = project;
      const res = await listPages(projectName, {
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
      const { pages } = await res.json();
      return {
        content: pages.map((page) => ({
          type: "text",
          text: `# Title: ${page.title}\n\n# Description\n${
            page.descriptions.join("\n")
          }`,
        })),
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
        `Search result for "${searchResult.query}":`,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
