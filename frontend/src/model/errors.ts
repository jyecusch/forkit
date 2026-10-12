import { Schema } from "effect"
import { ErrorCode, RpcError } from "./model.gen"

const details = Schema.Record(Schema.String, Schema.String)

/** The backend refused because the path is not inside a git repository. */
export class NotARepoError extends Schema.TaggedError<NotARepoError>()("NotARepoError", {
  message: Schema.String,
}) {}

/** The worktree has uncommitted changes that the operation would affect. */
export class DirtyWorktreeError extends Schema.TaggedError<DirtyWorktreeError>()("DirtyWorktreeError", {
  message: Schema.String,
  details,
}) {}

/** The branch is already checked out in another worktree. details.worktreeId names it. */
export class BranchCheckedOutElsewhereError extends Schema.TaggedError<BranchCheckedOutElsewhereError>()(
  "BranchCheckedOutElsewhereError",
  { message: Schema.String, details },
) {}

/** A merge, rebase or similar must be finished or aborted first. */
export class OperationInProgressError extends Schema.TaggedError<OperationInProgressError>()(
  "OperationInProgressError",
  { message: Schema.String, details },
) {}

/** Any other backend failure, identified by its shared error code. */
export class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
  code: ErrorCode,
  message: Schema.String,
  details,
}) {}

export type RpcFailure =
  | NotARepoError
  | DirtyWorktreeError
  | BranchCheckedOutElsewhereError
  | OperationInProgressError
  | BackendError

const decodeRpcError = Schema.decodeUnknownOption(Schema.fromJsonString(RpcError))

const rpcFailureClasses = [
  NotARepoError,
  DirtyWorktreeError,
  BranchCheckedOutElsewhereError,
  OperationInProgressError,
  BackendError,
]

/**
 * Turns a rejected binding promise into the matching tagged error. A
 * rejection that already is one, such as from a promise that ran an Effect,
 * is passed through.
 */
export const fromRejection = (rejection: unknown): RpcFailure => {
  if (rpcFailureClasses.some((errorClass) => rejection instanceof errorClass)) {
    return rejection as RpcFailure
  }
  const text = rejection instanceof Error ? rejection.message : String(rejection)
  const decoded = decodeRpcError(text)
  if (decoded._tag === "None") {
    return new BackendError({ code: "Internal", message: text, details: {} })
  }
  const { code, message } = decoded.value
  const errorDetails = decoded.value.details ?? {}
  switch (code) {
    case "NotARepo":
      return new NotARepoError({ message })
    case "DirtyWorktree":
      return new DirtyWorktreeError({ message, details: errorDetails })
    case "BranchCheckedOutElsewhere":
      return new BranchCheckedOutElsewhereError({ message, details: errorDetails })
    case "OperationInProgress":
      return new OperationInProgressError({ message, details: errorDetails })
    default:
      return new BackendError({ code, message, details: errorDetails })
  }
}
