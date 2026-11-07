import type { RunFailureReason } from "@earendil-works/pi-durable";

/** Errors of "continue" (`NekoSession.continueRun`); frontends map them by their code prefix. */
export const CONTINUE_BUSY = "CONTINUE_BUSY: The session is running; wait for it to finish.";
export const CONTINUE_UNAVAILABLE = "CONTINUE_UNAVAILABLE: The last run was answered; there is nothing to continue.";

/** Pi 1.5's reasons for a run that ended without an answer; frontends localize these and show others as they are. */
export const RUN_FAILURE_REASONS = [
	"model_error",
	"no_model",
	"aborted",
	"reset",
	"faulted",
	"orphaned",
	"interrupted",
	"restart_limit",
	"nothing_to_answer",
	"turn_limit",
] as const;

// A Pi upgrade that adds or removes a reason fails here: update the list, the fixture and the frontend dictionaries.
type Missing = Exclude<RunFailureReason, (typeof RUN_FAILURE_REASONS)[number]>;
type Unknown = Exclude<(typeof RUN_FAILURE_REASONS)[number], RunFailureReason>;
export const RUN_FAILURE_REASONS_COMPLETE: [Missing, Unknown] extends [never, never] ? true : never = true;
