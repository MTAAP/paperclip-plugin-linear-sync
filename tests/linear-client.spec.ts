import { describe, expect, it, vi } from "vitest";
import { LinearClient } from "../src/linear-client.js";
import {
  LinearAuthError,
  LinearGraphQLError,
  LinearNetworkError,
  LinearRateLimitError,
} from "../src/linear-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function gqlOk<T>(data: T) {
  return { data };
}

const VIEWER_DATA = {
  id: "user_1",
  name: "Test User",
  email: "test@example.com",
  displayName: "Test",
  avatarUrl: null,
  active: true,
};

const WORKFLOW_STATE = {
  id: "state_1",
  name: "In Progress",
  type: "started",
  color: "#0000FF",
  description: null,
  team: { id: "team_1", name: "Engineering" },
};

const ISSUE_DATA = {
  id: "issue_1",
  identifier: "ENG-1",
  title: "Test Issue",
  description: "A test issue",
  priority: 2,
  priorityLabel: "High",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  canceledAt: null,
  completedAt: null,
  url: "https://linear.app/eng/issue/ENG-1",
  state: WORKFLOW_STATE,
  team: { id: "team_1", name: "Engineering", key: "ENG" },
  assignee: null,
  labels: { nodes: [{ id: "label_1", name: "Paperclip", color: "#FF0000" }], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
  comments: { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
};

const COMMENT_DATA = {
  id: "comment_1",
  body: "Hello from Linear",
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-01T12:00:00Z",
  user: { id: "user_1", name: "Test User", email: "test@example.com", displayName: "Test" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinearClient", () => {
  describe("fetchViewer", () => {
    it("returns viewer on success", async () => {
      const fetch = makeFetch(200, gqlOk({ viewer: VIEWER_DATA }));
      const client = new LinearClient("lin_api_key", fetch);
      const viewer = await client.fetchViewer();
      expect(viewer.id).toBe("user_1");
      expect(viewer.email).toBe("test@example.com");
    });

    it("includes Authorization header", async () => {
      const fetch = makeFetch(200, gqlOk({ viewer: VIEWER_DATA }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.fetchViewer();
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      expect((options.headers as Record<string, string>)["Authorization"]).toBe("lin_api_key");
    });

    it("throws LinearAuthError on 401", async () => {
      const fetch = makeFetch(401, { message: "Unauthorized" });
      const client = new LinearClient("bad_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearAuthError);
    });

    it("throws LinearAuthError on 403", async () => {
      const fetch = makeFetch(403, { message: "Forbidden" });
      const client = new LinearClient("bad_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearAuthError);
    });

    it("throws LinearRateLimitError on 429 with Retry-After header", async () => {
      const fetch = makeFetch(429, {}, { "retry-after": "30" });
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearRateLimitError);
      try {
        await client.fetchViewer();
      } catch (e) {
        expect(e).toBeInstanceOf(LinearRateLimitError);
        expect((e as LinearRateLimitError).retryAfterSeconds).toBe(30);
      }
    });

    it("throws LinearRateLimitError with default 60s when no Retry-After", async () => {
      const fetch = makeFetch(429, {});
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearRateLimitError);
    });

    it("throws LinearNetworkError on fetch failure", async () => {
      const fetch = vi.fn().mockRejectedValue(new Error("Network down"));
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearNetworkError);
    });

    it("throws LinearGraphQLError on GraphQL errors", async () => {
      const fetch = makeFetch(200, { errors: [{ message: "Something went wrong" }] });
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearGraphQLError);
    });

    it("throws LinearAuthError on GraphQL auth error extension", async () => {
      const fetch = makeFetch(200, {
        errors: [{ message: "Not authenticated", extensions: { type: "AUTHENTICATION_ERROR" } }],
      });
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.fetchViewer()).rejects.toThrow(LinearAuthError);
    });
  });

  describe("fetchIssuesByLabel", () => {
    it("returns issue connection", async () => {
      const connection = {
        nodes: [ISSUE_DATA],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: "cursor_1" },
      };
      const fetch = makeFetch(200, gqlOk({ issues: connection }));
      const client = new LinearClient("lin_api_key", fetch);
      const result = await client.fetchIssuesByLabel("Paperclip");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].identifier).toBe("ENG-1");
    });

    it("passes updatedAfter filter in variables", async () => {
      const connection = { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      const fetch = makeFetch(200, gqlOk({ issues: connection }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.fetchIssuesByLabel("Paperclip", "2026-01-01T00:00:00Z");
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.filter.updatedAt).toEqual({ gte: "2026-01-01T00:00:00Z" });
    });

    it("passes cursor for pagination", async () => {
      const connection = { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      const fetch = makeFetch(200, gqlOk({ issues: connection }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.fetchIssuesByLabel("Paperclip", undefined, "cursor_abc");
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.after).toBe("cursor_abc");
    });

    it("omits updatedAt filter when not provided", async () => {
      const connection = { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      const fetch = makeFetch(200, gqlOk({ issues: connection }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.fetchIssuesByLabel("Paperclip");
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.filter.updatedAt).toBeUndefined();
    });
  });

  describe("fetchIssueComments", () => {
    it("returns comment connection", async () => {
      const connection = {
        nodes: [COMMENT_DATA],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
      const fetch = makeFetch(200, gqlOk({ issue: { comments: connection } }));
      const client = new LinearClient("lin_api_key", fetch);
      const result = await client.fetchIssueComments("issue_1");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].body).toBe("Hello from Linear");
    });

    it("passes afterCursor", async () => {
      const connection = { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      const fetch = makeFetch(200, gqlOk({ issue: { comments: connection } }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.fetchIssueComments("issue_1", "cursor_xyz");
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.after).toBe("cursor_xyz");
    });
  });

  describe("fetchWorkflowStates", () => {
    it("returns states array", async () => {
      const fetch = makeFetch(200, gqlOk({ team: { states: { nodes: [WORKFLOW_STATE] } } }));
      const client = new LinearClient("lin_api_key", fetch);
      const states = await client.fetchWorkflowStates("team_1");
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe("In Progress");
      expect(states[0].type).toBe("started");
    });
  });

  describe("fetchTeams", () => {
    it("returns teams array", async () => {
      const team = { id: "team_1", name: "Engineering", key: "ENG", description: null, color: null };
      const fetch = makeFetch(200, gqlOk({
        teams: {
          nodes: [team],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        },
      }));
      const client = new LinearClient("lin_api_key", fetch);
      const teams = await client.fetchTeams();
      expect(teams).toHaveLength(1);
      expect(teams[0].key).toBe("ENG");
    });
  });

  describe("updateIssueState", () => {
    it("calls issueUpdate mutation", async () => {
      const fetch = makeFetch(200, gqlOk({ issueUpdate: { success: true } }));
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.updateIssueState("issue_1", "state_done")).resolves.toBeUndefined();
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.query).toContain("issueUpdate");
      expect(body.variables.issueId).toBe("issue_1");
      expect(body.variables.stateId).toBe("state_done");
    });

    it("throws on auth error", async () => {
      const fetch = makeFetch(401, {});
      const client = new LinearClient("bad_key", fetch);
      await expect(client.updateIssueState("issue_1", "state_done")).rejects.toThrow(LinearAuthError);
    });
  });

  describe("updateIssuePriority", () => {
    it("calls issueUpdate with priority field", async () => {
      const fetch = makeFetch(200, gqlOk({ issueUpdate: { success: true } }));
      const client = new LinearClient("lin_api_key", fetch);
      await expect(client.updateIssuePriority("issue_1", 2)).resolves.toBeUndefined();
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.priority).toBe(2);
    });
  });

  describe("createComment", () => {
    it("returns created comment", async () => {
      const fetch = makeFetch(200, gqlOk({ commentCreate: { success: true, comment: COMMENT_DATA } }));
      const client = new LinearClient("lin_api_key", fetch);
      const comment = await client.createComment("issue_1", "Hello from Paperclip");
      expect(comment.id).toBe("comment_1");
      expect(comment.body).toBe("Hello from Linear");
    });

    it("passes issueId and body in variables", async () => {
      const fetch = makeFetch(200, gqlOk({ commentCreate: { success: true, comment: COMMENT_DATA } }));
      const client = new LinearClient("lin_api_key", fetch);
      await client.createComment("issue_1", "Hello from Paperclip");
      const [, options] = fetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.variables.issueId).toBe("issue_1");
      expect(body.variables.body).toBe("Hello from Paperclip");
    });
  });

  describe("rate limit retry behavior", () => {
    it("retryAfterSeconds is parsed from Retry-After header", async () => {
      const fetch = makeFetch(429, {}, { "retry-after": "45" });
      const client = new LinearClient("lin_api_key", fetch);
      let caught: unknown;
      try {
        await client.fetchTeams();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LinearRateLimitError);
      expect((caught as LinearRateLimitError).retryAfterSeconds).toBe(45);
    });
  });
});
