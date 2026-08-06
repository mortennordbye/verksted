export type RaccoonMood = "idle" | "thinking" | "speaking" | "listening";

/**
 * The assistant, as a raccoon.
 *
 * Drawn rather than imported: an inline SVG has no asset pipeline behind it, no
 * request to make, and recolours with the theme. It is the only decorative
 * thing in this app, which is why it is off unless you turn it on.
 *
 * What makes it read as a character rather than a diagram: the eyes sit low and
 * large with two catchlights each, every form is built from the same rounded
 * language, and the fur is shaded with gradients so the head has volume. It is
 * never entirely still — a frozen face reads as broken — and every part turns
 * about its own centre, which is what `.rc-part` is for.
 */
export default function Raccoon({
  mood,
  className = "",
}: {
  mood: RaccoonMood;
  className?: string;
}) {
  const speaking = mood === "speaking";
  const thinking = mood === "thinking";
  const listening = mood === "listening";

  return (
    <svg
      viewBox="-6 -6 172 176"
      className={className}
      role="img"
      aria-label={`the assistant, ${mood}`}
    >
      <defs>
        <linearGradient id="rc-fur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c3ccda" />
          <stop offset="0.55" stopColor="#9aa4b5" />
          <stop offset="1" stopColor="#7b8496" />
        </linearGradient>
        <linearGradient id="rc-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b94a5" />
          <stop offset="1" stopColor="#616a7a" />
        </linearGradient>
        <linearGradient id="rc-muzzle" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dbe1ea" />
        </linearGradient>
        <radialGradient id="rc-mask" cx="0.5" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#39414e" />
          <stop offset="1" stopColor="#232935" />
        </radialGradient>
      </defs>

      {/* Sits on something, rather than floating. */}
      <ellipse cx="80" cy="158" rx="42" ry="6" fill="#000" opacity="0.28" />

      <g className="rc-part animate-rc-sway">
        {/* Tail: one stroked curve, striped by dashing a second copy over it —
            cheaper and rounder than drawing each band as its own shape. The
            curve has to be long relative to the stroke or the bands converge
            and it reads as a fan rather than a tail, which is what the first
            attempt looked like. */}
        <g className="rc-part animate-rc-tail" style={{ transformOrigin: "110px 148px" }}>
          <path
            d="M 106 150 C 136 150 152 128 148 104 C 145 86 132 76 120 80"
            stroke="#6f7889"
            strokeWidth="21"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 106 150 C 136 150 152 128 148 104 C 145 86 132 76 120 80"
            stroke="#333b47"
            strokeWidth="21"
            strokeDasharray="11 13"
            strokeDashoffset="6"
            fill="none"
          />
        </g>

        {/* Shoulders */}
        <path
          d="M 36 168 C 36 132 56 118 80 118 C 104 118 124 132 124 168 Z"
          fill="url(#rc-body)"
        />

        {/* Scarf, in the app's accent: the one thing tying it to verksted. */}
        <path
          d="M 45 126 C 60 136 100 136 115 126 C 118 134 116 141 113 144 C 96 151 64 151 47 144 C 44 141 42 134 45 126 Z"
          fill="var(--color-accent)"
        />
        <path d="M 108 142 C 116 146 118 154 114 160 L 104 150 Z" fill="#c08f31" />

        {/* Ears, behind the head so the head's outline stays clean */}
        <g className={`rc-part ${listening ? "animate-rc-perk" : ""}`}>
          <path d="M 44 46 C 32 30 38 12 54 18 C 63 22 65 34 60 44 Z" fill="#8b94a5" />
          <path d="M 48 42 C 41 31 45 22 54 25 C 59 29 59 36 56 41 Z" fill="#c98d93" />
          <path d="M 116 46 C 128 30 122 12 106 18 C 97 22 95 34 100 44 Z" fill="#8b94a5" />
          <path d="M 112 42 C 119 31 115 22 106 25 C 101 29 101 36 104 41 Z" fill="#c98d93" />
        </g>

        {/* Head. The cheeks flare below the eyeline, which is most of what makes
            a face read as young rather than narrow. */}
        <g className={`rc-part ${thinking ? "animate-rc-think" : ""}`}>
          <path
            d="M 80 26 C 110 26 128 46 128 74 C 128 92 120 106 106 114 C 98 119 89 121 80 121
               C 71 121 62 119 54 114 C 40 106 32 92 32 74 C 32 46 50 26 80 26 Z"
            fill="url(#rc-fur)"
          />

          {/* The bandit mask: two lobes angled down towards the nose, joined
              across the bridge. Drawn as one path so the join is not a seam. */}
          <path
            d="M 44 66 C 48 54 66 50 73 60 C 76 64 84 64 87 60 C 94 50 112 54 116 66
               C 119 78 108 88 96 85 C 88 83 84 76 80 72 C 76 76 72 83 64 85 C 52 88 41 78 44 66 Z"
            fill="url(#rc-mask)"
          />

          {/* Brow tufts: a couple of fur points stop the mask looking painted on. */}
          <path
            d="M 48 58 C 52 50 60 47 66 49 C 59 50 52 53 48 58 Z"
            fill="#c3ccda"
            opacity="0.75"
          />
          <path
            d="M 112 58 C 108 50 100 47 94 49 C 101 50 108 53 112 58 Z"
            fill="#c3ccda"
            opacity="0.75"
          />

          {/* Eyes. Two catchlights each — one large, one small and opposite — is
              the difference between alive and taxidermied. */}
          <g className={`rc-part ${speaking ? "" : "animate-rc-blink"}`}>
            <ellipse cx="61" cy="68" rx="11" ry="11.5" fill="#fff" />
            <ellipse cx="99" cy="68" rx="11" ry="11.5" fill="#fff" />
            <circle cx="63" cy="69" r="7" fill="#1b1f27" />
            <circle cx="97" cy="69" r="7" fill="#1b1f27" />
            <circle cx="60.5" cy="66" r="2.8" fill="#fff" />
            <circle cx="94.5" cy="66" r="2.8" fill="#fff" />
            <circle cx="65.5" cy="72" r="1.3" fill="#fff" opacity="0.8" />
            <circle cx="99.5" cy="72" r="1.3" fill="#fff" opacity="0.8" />
          </g>

          <ellipse cx="45" cy="90" rx="8" ry="5.5" fill="#c98d93" opacity="0.4" />
          <ellipse cx="115" cy="90" rx="8" ry="5.5" fill="#c98d93" opacity="0.4" />

          <path
            d="M 80 84 C 95 84 104 93 102 102 C 100 111 89 116 80 116 C 71 116 60 111 58 102 C 56 93 65 84 80 84 Z"
            fill="url(#rc-muzzle)"
          />

          <path
            d="M 80 88 C 87 88 90 91.5 88.5 95 C 87 98.5 83 100.5 80 100.5 C 77 100.5 73 98.5 71.5 95 C 70 91.5 73 88 80 88 Z"
            fill="#242a33"
          />
          <ellipse cx="77.5" cy="91.5" rx="2.2" ry="1.4" fill="#fff" opacity="0.45" />

          {speaking ? (
            <g className="rc-part animate-rc-talk" style={{ transformOrigin: "80px 106px" }}>
              <path
                d="M 68 103 C 72 100 88 100 92 103 C 92 112 86 117 80 117 C 74 117 68 112 68 103 Z"
                fill="#2a2028"
              />
              <path
                d="M 73 111 C 76 108 84 108 87 111 C 86 115 83 117 80 117 C 77 117 74 115 73 111 Z"
                fill="#d98a94"
              />
            </g>
          ) : (
            <>
              <path
                d="M 80 100.5 L 80 105"
                stroke="#3a414e"
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M 80 105 C 77 110 71 110 69 106 M 80 105 C 83 110 89 110 91 106"
                stroke="#3a414e"
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
              />
            </>
          )}

          <g stroke="#e2e7ee" strokeWidth="1.6" strokeLinecap="round" opacity="0.55">
            <path d="M 56 96 L 42 93" />
            <path d="M 56 101 L 43 102" />
            <path d="M 104 96 L 118 93" />
            <path d="M 104 101 L 117 102" />
          </g>
        </g>
      </g>
    </svg>
  );
}
