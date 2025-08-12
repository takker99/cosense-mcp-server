export interface Config {
  cosenseSid?: string;
  projectName: string;
  editableProjects: string[];
  defaultRetryLimit: number;
}

export function getConfig(): Config {
  // DenoではDeno.envを使う
  const cosenseSid = Deno.env.get("COSENSE_SID");
  const projectName = Deno.env.get("COSENSE_PROJECT_NAME");
  const editableProjectsEnv = Deno.env.get("COSENSE_EDITABLE_PROJECTS");
  const retryLimitEnv = Deno.env.get("COSENSE_DEFAULT_RETRY_LIMIT");

  if (!projectName) {
    throw new Error("COSENSE_PROJECT_NAME is not set");
  }

  // Parse editable projects from comma-separated string
  const editableProjects = editableProjectsEnv
    ? editableProjectsEnv.split(",").map((p) => p.trim()).filter((p) =>
      p.length > 0
    )
    : [projectName]; // Default to only the main project if not specified

  // Parse retry limit with default fallback
  const defaultRetryLimit = retryLimitEnv ? parseInt(retryLimitEnv, 10) : 3;
  if (isNaN(defaultRetryLimit) || defaultRetryLimit < 0) {
    throw new Error(
      "COSENSE_DEFAULT_RETRY_LIMIT must be a non-negative integer",
    );
  }

  return {
    cosenseSid,
    projectName,
    editableProjects,
    defaultRetryLimit,
  };
}
