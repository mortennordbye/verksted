export type RaccoonMood = "idle" | "thinking" | "speaking" | "listening";

/**
 * The assistant, as an actual raccoon, whose jaw drops when it talks.
 *
 * Three copies of the same photo stacked exactly on top of each other, each
 * clipped to a horizontal band: the head above the mouth, the jaw, and the body
 * below the chin. Only the jaw band moves, so the ears and eyes stay perfectly
 * still and a dark gap opens where the mouth is.
 *
 * Clipping rather than three cropped files because the seams then cannot drift:
 * all three are the same image at the same size, so they line up by
 * construction at any scale, forever.
 *
 * The picture is generated, and cropped so the desk edge takes the generator's
 * watermark with it.
 */

/**
 * The jaw band, as percentages from the top of the picture. MOUTH is the line
 * the mouth opens along, CHIN is the bottom of the lower jaw.
 *
 * These two numbers are the only thing tied to the image, and they are easy to
 * get wrong by eye — the first attempt put them over the neck, which opened a
 * gap in the collar. Measure rather than guess: overlay a translucent band on
 * the photo at a few ranges and look at which one covers the muzzle.
 */
const MOUTH = 32;
const CHIN = 37;

export default function Raccoon({
  mood,
  className = "",
}: {
  mood: RaccoonMood;
  className?: string;
}) {
  return (
    <div
      // The dark ground is what shows through the gap, so it reads as the
      // inside of a mouth rather than a hole in the picture.
      className={`relative overflow-hidden rounded-xl bg-[#120c0d] select-none ${className}`}
      role="img"
      aria-label={`the assistant, ${mood}`}
    >
      {/* Body, below the chin. In flow, so it sets the height the other two
          absolute layers stretch to. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className="block w-full"
        style={{ clipPath: `inset(${CHIN}% 0 0 0)` }}
      />

      {/* The jaw: the only part that moves. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className={`absolute inset-0 block w-full ${mood === "speaking" ? "animate-rc-chew" : ""}`}
        style={{ clipPath: `inset(${MOUTH}% 0 ${100 - CHIN}% 0)` }}
      />

      {/* Head, above the mouth. Last so it sits over the jaw as that drops. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className="absolute inset-0 block w-full"
        style={{ clipPath: `inset(0 0 ${100 - MOUTH}% 0)` }}
      />
    </div>
  );
}
