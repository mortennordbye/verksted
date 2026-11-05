import type { CouncilColour } from "../../../shared/api";

/**
 * A council member's colour, as the classes Tailwind has to see. A member is drawn
 * as a name in type, with no avatar.
 *
 * The hue classes are written out rather than interpolated because Tailwind scans
 * source text: a class assembled at runtime never reaches the stylesheet.
 */
export const MEMBER_TEXT: Record<CouncilColour, string> = {
  amber: "text-member-amber",
  violet: "text-member-violet",
  teal: "text-member-teal",
  rose: "text-member-rose",
  sky: "text-member-sky",
  lime: "text-member-lime",
};

export const MEMBER_RULE: Record<CouncilColour, string> = {
  amber: "border-member-amber/40",
  violet: "border-member-violet/40",
  teal: "border-member-teal/40",
  rose: "border-member-rose/40",
  sky: "border-member-sky/40",
  lime: "border-member-lime/40",
};

export const MEMBER_DOT: Record<CouncilColour, string> = {
  amber: "bg-member-amber",
  violet: "bg-member-violet",
  teal: "bg-member-teal",
  rose: "bg-member-rose",
  sky: "bg-member-sky",
  lime: "bg-member-lime",
};

/** A card tinted with what they said: their colour, faintly, edge and ground. */
export const MEMBER_CARD: Record<CouncilColour, string> = {
  amber: "bg-member-amber/[.07] ring-member-amber/25",
  violet: "bg-member-violet/[.07] ring-member-violet/25",
  teal: "bg-member-teal/[.07] ring-member-teal/25",
  rose: "bg-member-rose/[.07] ring-member-rose/25",
  sky: "bg-member-sky/[.07] ring-member-sky/25",
  lime: "bg-member-lime/[.07] ring-member-lime/25",
};

/** A turn in flight: the only thing that moves while somebody is working. */
export function WorkingDot({ colour }: { colour: CouncilColour }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full ${MEMBER_DOT[colour]}`}
    />
  );
}
