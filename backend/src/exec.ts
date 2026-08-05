import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * promisify(execFile), which nine modules each declared for themselves.
 *
 * Always the argv form, never a shell string: every caller here passes client
 * input somewhere in the arguments, and that is the property the whole command
 * surface depends on.
 */
export const exec = promisify(execFile);
