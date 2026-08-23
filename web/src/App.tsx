import { useEffect, useState } from "react";
import { Landing } from "./routes/Landing";
import { Room } from "./routes/Room";

type Route =
  | { kind: "landing" }
  | { kind: "unlisted"; roomIdHex: string; fragment: string }
  | { kind: "named"; name: string };

function parseRoute(): Route {
  const path = window.location.pathname;
  const fragment = window.location.hash;
  const unlisted = path.match(/^\/r\/([0-9a-f]{32})\/?$/);
  if (unlisted) return { kind: "unlisted", roomIdHex: unlisted[1], fragment };
  const named = path.match(/^\/n\/([a-z0-9-]+)\/?$/);
  if (named) return { kind: "named", name: named[1] };
  return { kind: "landing" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  switch (route.kind) {
    case "landing":
      return <Landing />;
    case "unlisted":
      return <Room roomIdHex={route.roomIdHex} fragment={route.fragment} />;
    case "named":
      return <Room name={route.name} />;
  }
}
