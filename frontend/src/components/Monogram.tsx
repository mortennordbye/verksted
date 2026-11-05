import type { CouncilColour } from "../../../shared/api";

/**
 * Who is speaking: a member's initial in their own colour.
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

export const MEMBER_FILL: Record<CouncilColour, string> = {
  amber: "bg-member-amber/15",
  violet: "bg-member-violet/15",
  teal: "bg-member-teal/15",
  rose: "bg-member-rose/15",
  sky: "bg-member-sky/15",
  lime: "bg-member-lime/15",
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

export default function Monogram({
  name,
  colour,
  speaking = false,
  size = 30,
  title,
}: {
  name: string;
  colour: CouncilColour;
  speaking?: boolean;
  size?: number;
  title?: string;
}) {
  return (
    <span
      aria-hidden="true"
      title={title}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      className={`inline-flex flex-none items-center justify-center rounded-full font-semibold select-none ${MEMBER_TEXT[colour]} ${MEMBER_FILL[colour]} ${
        speaking ? "animate-glow" : ""
      }`}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
