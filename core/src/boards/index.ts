// The board readers Discover knows. A Target company whose ATS has no reader yet is
// recorded on the Discover run as a skipped source, never silently ignored.
import { ashby } from "./ashby.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import type { Ats, Board, BoardReader } from "./reader.ts";
import { workday } from "./workday.ts";

export const BOARD_READERS: Partial<Record<Ats, BoardReader>> = {
  greenhouse,
  lever,
  ashby,
  workday,
};

export const ATS_NAMES: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
};

/**
 * A board's stable ID, used as the Discover run's source ID and as the prefix of its
 * Listing IDs: "greenhouse:acme", "lever:acme", "ashby:Acme", "workday:fabrikam:Careers".
 */
export function boardId(board: Board): string {
  return board.ats === "workday"
    ? `workday:${board.tenant}:${board.site}`
    : `${board.ats}:${board.token}`;
}
