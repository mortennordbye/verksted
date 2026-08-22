import type { ReactNode } from "react";
import type { CouncilColour, CouncilFace } from "../../../shared/api";

/**
 * The council, drawn.
 *
 * A member used to be a coloured dot and an @id, which is enough to tell them
 * apart and nothing like enough to remember who they are. Four hues is already
 * more than anyone reliably distinguishes on a phone; a silhouette with ears is
 * recognisable at 26px and from the corner of your eye.
 *
 * Animals rather than people, and one line weight for all of them: at this size
 * human faces differ only by hair and read as one face repeated, and a portrait
 * that is a photograph would be a file per member on a volume that holds JSON.
 *
 * Everything here is drawn in `currentColor`, so a face is tinted by whatever
 * text colour it inherits — which is how a member's colour reaches it without
 * any of these paths knowing that colours exist.
 */
export type FaceMood = "idle" | "thinking" | "speaking";

/** The order the picker offers them in, and the whole set that exists. */
export const FACES: CouncilFace[] = ["owl", "fox", "bear", "cat", "robot", "raccoon"];

/**
 * The hue tokens a member may carry, as the classes Tailwind has to see.
 *
 * Written out rather than interpolated because Tailwind scans source text: a
 * class assembled at runtime is a class that never reaches the stylesheet.
 * They live here, with the drawing, because everywhere a member is shown needs
 * the same three.
 */
export const MEMBER_TEXT: Record<CouncilColour, string> = {
  amber: "text-member-amber",
  violet: "text-member-violet",
  teal: "text-member-teal",
  rose: "text-member-rose",
  sky: "text-member-sky",
  lime: "text-member-lime",
};

export const MEMBER_DOT: Record<CouncilColour, string> = {
  amber: "bg-member-amber",
  violet: "bg-member-violet",
  teal: "bg-member-teal",
  rose: "bg-member-rose",
  sky: "bg-member-sky",
  lime: "bg-member-lime",
};

export const MEMBER_RULE: Record<CouncilColour, string> = {
  amber: "border-member-amber/40",
  violet: "border-member-violet/40",
  teal: "border-member-teal/40",
  rose: "border-member-rose/40",
  sky: "border-member-sky/40",
  lime: "border-member-lime/40",
};

/**
 * Eyes, and what the mood does to them.
 *
 * Open when idle, wider while speaking, and lidded while thinking — the one
 * state where a still drawing has to say something is happening without moving.
 */
function Eyes({ mood, x, y, r = 1.6 }: { mood: FaceMood; x: number; y: number; r?: number }) {
  const left = 16 - x;
  const right = 16 + x;
  if (mood === "thinking") {
    return (
      <>
        <path d={`M${left - r} ${y} q ${r} ${-r * 1.7} ${r * 2} 0`} />
        <path d={`M${right - r} ${y} q ${r} ${-r * 1.7} ${r * 2} 0`} />
      </>
    );
  }
  const size = mood === "speaking" ? r * 1.15 : r;
  return (
    <g fill="currentColor" stroke="none">
      <circle cx={left} cy={y} r={size} />
      <circle cx={right} cy={y} r={size} />
    </g>
  );
}

/**
 * A mouth that opens when there are words.
 *
 * The open one animates rather than sitting open: a fixed hole reads as a
 * surprised face, and the thing being said is that this one is talking now.
 */
function Mouth({ mood, y, w = 3 }: { mood: FaceMood; y: number; w?: number }) {
  if (mood === "speaking") {
    return (
      <ellipse
        cx={16}
        cy={y + 0.6}
        rx={w * 0.5}
        ry={w * 0.52}
        className="vk-talk animate-vk-talk"
        fill="currentColor"
        stroke="none"
      />
    );
  }
  if (mood === "thinking") return <path d={`M${16 - w * 0.7} ${y} h ${w * 1.4}`} />;
  return <path d={`M${16 - w * 0.8} ${y - 0.5} q ${w * 0.8} ${w * 0.75} ${w * 1.6} 0`} />;
}

/**
 * One drawing per face: the silhouette, and where the features sit on it.
 *
 * Kept as data rather than six components because the eyes and the mouth are
 * the same drawing on all of them — only the head around them differs, which is
 * the whole of what makes one recognisable.
 */
const DRAWINGS: Record<
  CouncilFace,
  { head: ReactNode; eyeX: number; eyeY: number; eyeR?: number; mouthY: number; mouthW?: number }
> = {
  owl: {
    head: (
      <>
        <path d="M16 5.5c-5.7 0-9.6 4.4-9.6 10.4S10.3 26.5 16 26.5s9.6-4.6 9.6-10.6S21.7 5.5 16 5.5z" />
        <path d="M8.2 9.2 7 4.4l4.6 2.2M23.8 9.2 25 4.4l-4.6 2.2" />
        <circle cx="11.7" cy="15" r="3.5" />
        <circle cx="20.3" cy="15" r="3.5" />
      </>
    ),
    eyeX: 4.3,
    eyeY: 15,
    eyeR: 1.5,
    mouthY: 20.8,
    mouthW: 2.4,
  },
  fox: {
    // A snout is what makes a fox a fox: without one the pointed ears alone
    // read as a cat, which is the animal two rows down.
    head: (
      <>
        <path d="M9.6 10.8 7 4.2l6.2 3M22.4 10.8l2.6-6.6-6.2 3" />
        <path d="M16 8.4c-4.6 0-7.8 2.8-7.8 7.2 0 5.4 2.4 9 4.8 11.1l3 2.6 3-2.6c2.4-2.1 4.8-5.7 4.8-11.1 0-4.4-3.2-7.2-7.8-7.2z" />
        <path d="M13.6 21.4 16 23.6l2.4-2.2" />
        <circle cx="16" cy="20.8" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
    eyeX: 3.9,
    eyeY: 16.2,
    eyeR: 1.4,
    mouthY: 25.2,
    mouthW: 2,
  },
  bear: {
    head: (
      <>
        <circle cx="8.8" cy="9" r="3.4" />
        <circle cx="23.2" cy="9" r="3.4" />
        <circle cx="16" cy="17" r="9.4" />
        <ellipse cx="16" cy="20.8" rx="4.6" ry="3.4" />
      </>
    ),
    eyeX: 4.2,
    eyeY: 14.8,
    mouthY: 20.8,
    mouthW: 2.6,
  },
  cat: {
    head: (
      <>
        <path d="M8.6 11.4 6.6 4.2l6.8 3.2M23.4 11.4l2-7.2-6.8 3.2" />
        <circle cx="16" cy="17.4" r="9.2" />
        <path d="M5 19h4M5 22h4M23 19h4M23 22h4" />
      </>
    ),
    eyeX: 4.2,
    eyeY: 16,
    mouthY: 21.6,
    mouthW: 2.4,
  },
  robot: {
    head: (
      <>
        <path d="M16 8.6V4.4" />
        <circle cx="16" cy="3.2" r="1.5" />
        <rect x="5.6" y="8.6" width="20.8" height="17.4" rx="5.2" />
        <path d="M3.4 15.4v4M28.6 15.4v4" />
      </>
    ),
    eyeX: 4.6,
    eyeY: 15.8,
    mouthY: 21.4,
    mouthW: 3.4,
  },
  raccoon: {
    // The mask is the whole animal, so it is stroked as well as filled: a wash
    // at this size is a smudge that disappears the moment the icon is 18px.
    head: (
      <>
        <path d="M9.2 10.4 7.4 4.6l6.2 3M22.8 10.4l1.8-5.8-6.2 3" />
        <circle cx="16" cy="17.2" r="9.3" />
        <path
          d="M7.2 14.6c2.5-2.4 5.4-3.4 8.8-3.4s6.3 1 8.8 3.4c-1.2 3.4-4 5.2-8.8 5.2s-7.6-1.8-8.8-5.2z"
          fill="currentColor"
          fillOpacity=".16"
          strokeWidth="1.1"
        />
        <circle cx="16" cy="20.9" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    eyeX: 4.3,
    eyeY: 15.4,
    eyeR: 1.4,
    mouthY: 23.2,
    mouthW: 2.2,
  },
};

/** One face, drawn at whatever size and colour it is given. */
export function Face({
  face,
  mood = "idle",
  className = "",
}: {
  face: CouncilFace;
  mood?: FaceMood;
  className?: string;
}) {
  const d = DRAWINGS[face] ?? DRAWINGS.owl;
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {d.head}
      <Eyes mood={mood} x={d.eyeX} y={d.eyeY} r={d.eyeR} />
      <Mouth mood={mood} y={d.mouthY} w={d.mouthW} />
    </svg>
  );
}

/**
 * A face in its own colour, in a ring that says whether it is talking.
 *
 * The ring is what makes a roster of six readable at a glance: a member with a
 * turn in flight is the one with a lit edge, which is the same thing the status
 * chips elsewhere on this bench do with the same colour.
 */
export default function Portrait({
  face,
  colour,
  mood = "idle",
  size = 30,
  title,
}: {
  face: CouncilFace;
  colour: CouncilColour;
  mood?: FaceMood;
  size?: number;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{ width: size, height: size }}
      className={`inline-flex flex-none items-center justify-center rounded-full border bg-surface-2 ${
        MEMBER_TEXT[colour]
      } ${MEMBER_RULE[colour]} ${mood === "speaking" ? "animate-pulse-run" : ""}`}
    >
      <Face face={face} mood={mood} className="h-[70%] w-[70%]" />
    </span>
  );
}
