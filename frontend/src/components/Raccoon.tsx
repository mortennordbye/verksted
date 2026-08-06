export type RaccoonMood = "idle" | "thinking" | "speaking" | "listening";

/**
 * The assistant, as an actual raccoon, whose head comes apart at the mouth and
 * flaps when it talks. The reference is a South Park Canadian.
 *
 * The trick is two copies of the same photo stacked exactly on top of each
 * other, each clipped to one side of the mouth line: the lower jaw stays put
 * and the rest of the head hinges up. Clipping rather than two cropped files
 * because the seam then cannot drift — both halves are the same image at the
 * same size, so they line up by construction, at any size, forever.
 *
 * The picture is generated, and cropped so the desk edge takes the generator's
 * watermark with it.
 */

/**
 * Where the head comes apart, as a percentage from the top.
 *
 * Just under the chin rather than through the mouth, which is the one place
 * this differs from the cartoon it is imitating: a photoreal muzzle sliced in
 * half reads as gruesome rather than funny. Hinging the whole head off the
 * collar gets the same joke and stays likeable. Retune this if the picture
 * changes — it is the only number that has to match the image.
 */
const JAW = 34;

export default function Raccoon({
  mood,
  className = "",
}: {
  mood: RaccoonMood;
  className?: string;
}) {
  const speaking = mood === "speaking";
  const listening = mood === "listening";

  return (
    <div
      // overflow-hidden because the top half rotates: without it the head
      // swings outside its own frame. The dark ground is what shows through the
      // gap, so it reads as the inside of a mouth rather than a hole.
      className={`relative overflow-hidden rounded-xl bg-[#1b1012] select-none ${className}`}
      role="img"
      aria-label={`the assistant, ${mood}`}
    >
      {/* The lower jaw: the half that stays where it is. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className="block w-full"
        style={{ clipPath: `inset(${JAW}% 0 0 0)` }}
      />

      {/* Everything above the mouth, hinged near the back of the jaw. Absolute
          so it sits exactly over the copy below rather than beside it. */}
      <img
        src="/raccoon.jpg"
        alt=""
        draggable={false}
        className={`absolute inset-0 block w-full ${
          speaking ? "animate-rc-flap" : listening ? "animate-rc-perk" : "animate-rc-sway"
        }`}
        // Hinged near the back of the jaw rather than the centre, so it opens
        // like a mouth instead of the whole head sliding upwards.
        style={{ clipPath: `inset(0 0 ${100 - JAW}% 0)`, transformOrigin: "14% 74%" }}
      />

      {/* Without this the seam reads as a cut. A shadow under the lifting edge
          makes the top half look hinged rather than slid. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0"
        style={{
          top: `${JAW - 3}%`,
          height: "7%",
          background: "linear-gradient(to bottom, rgba(0,0,0,0.5), transparent)",
          opacity: speaking ? 1 : 0.3,
          transition: "opacity .2s",
        }}
      />
    </div>
  );
}
