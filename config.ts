export interface Config {
  cosenseSid?: string;
  projectName: string;
  editableProjects: string[];
  denyProjects: string[];
}

export function getConfig(): Config {
  // DenoではDeno.envを使う
  const cosenseSid = Deno.env.get("COSENSE_SID");
  const projectName = Deno.env.get("COSENSE_PROJECT_NAME");
  const editableProjectsEnv = Deno.env.get("COSENSE_EDITABLE_PROJECTS");
  const denyProjectsEnv = Deno.env.get("COSENSE_DENY_PROJECTS");

  if (!projectName) {
    throw new Error("COSENSE_PROJECT_NAME is not set");
  }

  // Parse editable projects from comma-separated string - supports regex patterns
  const editableProjects = editableProjectsEnv
    ? editableProjectsEnv.split(",").map((p) => p.trim()).filter((p) =>
      p.length > 0
    )
    : [projectName]; // Default to only the main project if not specified

  // Parse deny projects from comma-separated string - supports regex patterns
  const denyProjects = denyProjectsEnv
    ? denyProjectsEnv.split(",").map((p) => p.trim()).filter((p) =>
      p.length > 0
    )
    : []; // Default to no denied projects

  return {
    cosenseSid,
    projectName,
    editableProjects,
    denyProjects,
  };
}

/**
 * Check if a project is writable based on allow/deny lists that support regex patterns
 */
export function isProjectWritable(
  projectName: string,
  config: Config,
): boolean {
  // First check deny list - if matches any deny pattern, project is not writable
  for (const denyPattern of config.denyProjects) {
    try {
      const regex = new RegExp(denyPattern);
      if (regex.test(projectName)) {
        return false;
      }
    } catch {
      // If regex is invalid, treat as literal string match
      if (denyPattern === projectName) {
        return false;
      }
    }
  }

  // Then check allow list - if matches any allow pattern, project is writable
  for (const allowPattern of config.editableProjects) {
    try {
      const regex = new RegExp(allowPattern);
      if (regex.test(projectName)) {
        return true;
      }
    } catch {
      // If regex is invalid, treat as literal string match
      if (allowPattern === projectName) {
        return true;
      }
    }
  }

  // If not in allow list, not writable
  return false;
}
