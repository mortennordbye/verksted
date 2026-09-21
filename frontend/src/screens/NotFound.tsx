import { Link } from "react-router";
import PageHeader from "../components/PageHeader";
import TopBar from "../components/TopBar";
import { buttonClass } from "../components/ui/Button";

/** Catch-all: an unknown URL used to render a blank page with no way back. */
export default function NotFound() {
  return (
    <>
      <TopBar back="/" crumb={[{ label: "not found" }]} />
      <main className="mx-auto max-w-[700px] px-[18px] pt-[22px]">
        <PageHeader
          icon="alert"
          label="Not found"
          title="No such page"
          sub={
            <>
              Nothing is routed at{" "}
              <code className="font-mono text-[12.5px]">{location.pathname}</code>.
            </>
          }
        />
        <Link to="/" className={buttonClass("primary")}>
          back to the hub
        </Link>
      </main>
    </>
  );
}
