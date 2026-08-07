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
 * These two numbers are the only thing tied to the image and they took four
 * goes to get right, because every error looks fine until it moves. Too low and
 * the gap opens in the shirt collar; too high and the cut runs through the nose,
 * which is invisible while the mouth is shut and gives the raccoon two noses the
 * moment it is not.
 *
 * Measure, do not estimate: overlay guide lines on the photo, magnify the
 * muzzle, and read off where the nose ends. Then check it open, magnified,
 * before believing it.
 */
const MOUTH = 35;
const CHIN = 39;

/**
 * How far each band reaches up underneath the one above it.
 *
 * Bands that meet on an exact boundary show a hairline: a clip edge that does
 * not land on a whole pixel antialiases, and two such edges over each other let
 * the background through. Overlapping puts more photo behind every visible
 * edge instead.
 *
 * The two are different sizes for a reason worth keeping. Under the body the
 * overlap is free, because that edge never moves. Under the head it is not:
 * whatever the jaw hides up there slides into view the moment it drops, and at
 * 0.8 that was enough of the nose to give the raccoon a second one. A hairline
 * is all that edge can afford.
 */
const BLEED_UNDER_HEAD = 0.25;
const BLEED_UNDER_BODY = 0.8;

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
        style={{ clipPath: `inset(${CHIN - BLEED_UNDER_BODY}% 0 0 0)` }}
      />

      {/* The jaw: the only part that moves. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        // top-0 left-0 rather than inset-0: inset stretches the layer to the
        // container's height, which can round to a pixel off the in-flow copy
        // and put a seam where the bands meet. Left to itself, every layer is
        // the same intrinsic size.
        className={`absolute top-0 left-0 block w-full ${
          mood === "speaking" ? "animate-rc-chew" : ""
        }`}
        style={{ clipPath: `inset(${MOUTH - BLEED_UNDER_HEAD}% 0 ${100 - CHIN}% 0)` }}
      />

      {/* Head, above the mouth. Last so it sits over the jaw as that drops. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className="absolute top-0 left-0 block w-full"
        style={{ clipPath: `inset(0 0 ${100 - MOUTH}% 0)` }}
      />
    </div>
  );
}
