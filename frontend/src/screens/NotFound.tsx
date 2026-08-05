import { Link } from "react-router";
import TopBar from "../components/TopBar";

/** Catch-all: an unknown URL used to render a blank page with no way back. */
export default function NotFound() {
  return (
    <>
      <TopBar back="/" crumb={["not found"]} />
      <main className="mx-auto max-w-[700px] px-[18px] pt-[22px]">
        <h1 className="mb-2 text-[21px] font-semibold tracking-tight">no such page</h1>
        <p className="mb-4 text-sm text-muted">
          Nothing is routed at <code className="font-mono text-[12.5px]">{location.pathname}</code>.
        </p>
        <Link
          to="/"
          className="inline-block rounded-[7px] bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-[#16130a] hover:brightness-110"
        >
          back to the hub
        </Link>
      </main>
    </>
  );
}
