// Linear API TypeScript types

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface LinearPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface LinearConnection<T> {
  nodes: T[];
  pageInfo: LinearPageInfo;
}

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface LinearUser {
  id: string;
  name: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  active: boolean;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
  description: string | null;
  color: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
  team: Pick<LinearTeam, "id" | "name"> | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  color: string;
  description: string | null;
  team: Pick<LinearTeam, "id" | "name">;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: Pick<LinearUser, "id" | "name" | "email" | "displayName"> | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  canceledAt: string | null;
  completedAt: string | null;
  state: LinearWorkflowState;
  team: Pick<LinearTeam, "id" | "name" | "key">;
  assignee: Pick<LinearUser, "id" | "name" | "email" | "displayName"> | null;
  labels: LinearConnection<Pick<LinearLabel, "id" | "name" | "color">>;
  comments: LinearConnection<LinearComment>;
  url: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class LinearAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "LinearAuthError";
    this.statusCode = statusCode;
  }
}

export class LinearRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Linear API rate limit exceeded. Retry after ${retryAfterSeconds}s.`);
    this.name = "LinearRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class LinearNetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LinearNetworkError";
    this.cause = cause;
  }
}

export class LinearGraphQLError extends Error {
  readonly errors: Array<{ message: string; extensions?: Record<string, unknown> }>;
  constructor(errors: Array<{ message: string; extensions?: Record<string, unknown> }>) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "LinearGraphQLError";
    this.errors = errors;
  }
}
