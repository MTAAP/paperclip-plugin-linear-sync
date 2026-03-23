import {
  LinearAuthError,
  LinearGraphQLError,
  LinearNetworkError,
  LinearRateLimitError,
  type LinearComment,
  type LinearConnection,
  type LinearIssue,
  type LinearProject,
  type LinearTeam,
  type LinearUser,
  type LinearWorkflowState,
} from "./linear-types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

type FetchFn = typeof fetch;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Fragments (shared field sets)
// ---------------------------------------------------------------------------

const PAGE_INFO_FRAGMENT = `
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
`;

const WORKFLOW_STATE_FIELDS = `
  id name type color description
  team { id name }
`;

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  priorityLabel
  createdAt
  updatedAt
  canceledAt
  completedAt
  url
  state { ${WORKFLOW_STATE_FIELDS} }
  team { id name key }
  project { id name }
  assignee { id name email displayName }
  labels(first: 20) {
    nodes { id name color }
    ${PAGE_INFO_FRAGMENT}
  }
  comments(first: 50) {
    nodes {
      id body createdAt updatedAt
      user { id name email displayName }
    }
    ${PAGE_INFO_FRAGMENT}
  }
`;

// ---------------------------------------------------------------------------
// LinearClient
// ---------------------------------------------------------------------------

export class LinearClient {
  private readonly apiKey: string;
  private readonly fetch: FetchFn;

  constructor(apiKey: string, fetchFn?: FetchFn) {
    this.apiKey = apiKey;
    this.fetch = fetchFn ?? globalThis.fetch;
  }

  // -------------------------------------------------------------------------
  // Core request helper
  // -------------------------------------------------------------------------

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new LinearNetworkError(`Network error contacting Linear API: ${String(err)}`, err);
    }

    if (response.status === 401 || response.status === 403) {
      throw new LinearAuthError(
        `Linear API authentication failed (HTTP ${response.status})`,
        response.status,
      );
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "60", 10);
      throw new LinearRateLimitError(isNaN(retryAfter) ? 60 : retryAfter);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LinearNetworkError(
        `Linear API returned HTTP ${response.status}: ${body}`,
      );
    }

    let json: GraphQLResponse<T>;
    try {
      json = (await response.json()) as GraphQLResponse<T>;
    } catch (err) {
      throw new LinearNetworkError(`Failed to parse Linear API response as JSON`, err);
    }

    if (json.errors && json.errors.length > 0) {
      // Surface auth errors from GraphQL error extensions
      const authError = json.errors.find(
        (e) => e.extensions?.type === "AUTHENTICATION_ERROR" || e.extensions?.type === "FORBIDDEN",
      );
      if (authError) {
        throw new LinearAuthError(authError.message, 401);
      }
      throw new LinearGraphQLError(json.errors);
    }

    if (json.data === undefined) {
      throw new LinearNetworkError("Linear API returned a response with no data");
    }

    return json.data;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Fetch issues that have a specific label, optionally filtered by updatedAt >= updatedAfter.
   * Supports cursor-based pagination.
   */
  async fetchIssuesByLabel(
    labelName: string,
    updatedAfter?: string,
    cursor?: string,
  ): Promise<LinearConnection<LinearIssue>> {
    const query = `
      query FetchIssuesByLabel($filter: IssueFilter, $first: Int, $after: String) {
        issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
          ${PAGE_INFO_FRAGMENT}
        }
      }
    `;

    const filter: Record<string, unknown> = {
      labels: { name: { eq: labelName } },
    };

    if (updatedAfter) {
      filter.updatedAt = { gte: updatedAfter };
    }

    const data = await this.request<{ issues: LinearConnection<LinearIssue> }>(query, {
      filter,
      first: 50,
      after: cursor ?? null,
    });

    return data.issues;
  }

  /**
   * Fetch comments on a Linear issue with cursor pagination.
   */
  async fetchIssueComments(
    issueId: string,
    afterCursor?: string,
  ): Promise<LinearConnection<LinearComment>> {
    const query = `
      query FetchIssueComments($issueId: String!, $after: String) {
        issue(id: $issueId) {
          comments(first: 100, after: $after) {
            nodes {
              id body createdAt updatedAt
              user { id name email displayName }
            }
            ${PAGE_INFO_FRAGMENT}
          }
        }
      }
    `;

    const data = await this.request<{ issue: { comments: LinearConnection<LinearComment> } }>(
      query,
      { issueId, after: afterCursor ?? null },
    );

    return data.issue.comments;
  }

  /**
   * Fetch all workflow states for a team.
   */
  async fetchWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    const query = `
      query FetchWorkflowStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes { ${WORKFLOW_STATE_FIELDS} }
          }
        }
      }
    `;

    const data = await this.request<{
      team: { states: LinearConnection<LinearWorkflowState> };
    }>(query, { teamId });

    return data.team.states.nodes;
  }

  /**
   * List all teams in the workspace.
   */
  async fetchTeams(): Promise<LinearTeam[]> {
    const query = `
      query FetchTeams($first: Int, $after: String) {
        teams(first: $first, after: $after) {
          nodes {
            id name key description color
          }
          ${PAGE_INFO_FRAGMENT}
        }
      }
    `;

    const all: LinearTeam[] = [];
    let after: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const data: { teams: LinearConnection<LinearTeam> } =
        await this.request(query, { first: 100, after });
      all.push(...data.teams.nodes);
      hasNext = data.teams.pageInfo.hasNextPage;
      after = data.teams.pageInfo.endCursor;
    }
    return all;
  }

  /**
   * List all projects in the workspace.
   */
  async fetchProjects(): Promise<LinearProject[]> {
    const query = `
      query FetchProjects($first: Int, $after: String) {
        projects(first: $first, after: $after) {
          nodes {
            id name description color
          }
          ${PAGE_INFO_FRAGMENT}
        }
      }
    `;

    const all: LinearProject[] = [];
    let after: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const data: { projects: LinearConnection<LinearProject> } =
        await this.request(query, { first: 100, after });
      all.push(...data.projects.nodes);
      hasNext = data.projects.pageInfo.hasNextPage;
      after = data.projects.pageInfo.endCursor;
    }
    return all;
  }

  /**
   * List all active members in the workspace.
   */
  async fetchUsers(): Promise<LinearUser[]> {
    const query = `
      query FetchUsers {
        users(first: 100) {
          nodes {
            id name email displayName avatarUrl active
          }
        }
      }
    `;

    const data = await this.request<{ users: LinearConnection<LinearUser> }>(query);
    return data.users.nodes;
  }

  /**
   * Fetch the authenticated user/app info (for health check).
   */
  async fetchViewer(): Promise<LinearUser> {
    const query = `
      query FetchViewer {
        viewer {
          id name email displayName avatarUrl active
        }
      }
    `;

    const data = await this.request<{ viewer: LinearUser }>(query);
    return data.viewer;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Change an issue's workflow state.
   */
  async updateIssueState(issueId: string, stateId: string): Promise<void> {
    const mutation = `
      mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `;

    await this.request<{ issueUpdate: { success: boolean } }>(mutation, { issueId, stateId });
  }

  /**
   * Change an issue's priority.
   * Linear priority scale: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
   */
  async updateIssuePriority(issueId: string, priority: number): Promise<void> {
    const mutation = `
      mutation UpdateIssuePriority($issueId: String!, $priority: Int!) {
        issueUpdate(id: $issueId, input: { priority: $priority }) {
          success
        }
      }
    `;

    await this.request<{ issueUpdate: { success: boolean } }>(mutation, { issueId, priority });
  }

  /**
   * Post a comment on a Linear issue.
   */
  async createComment(issueId: string, body: string): Promise<LinearComment> {
    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id body createdAt updatedAt
            user { id name email displayName }
          }
        }
      }
    `;

    const data = await this.request<{
      commentCreate: { success: boolean; comment: LinearComment };
    }>(mutation, { issueId, body });

    return data.commentCreate.comment;
  }
}
