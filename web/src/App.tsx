import { useEffect, useState } from "react";
import { Landing } from "./routes/Landing";
import { Room } from "./routes/Room";
import { takePendingNamedRoom, takeRoomKey } from "./keyhandoff";

type Route =
  | { kind: "landing" }
  | { kind: "unlisted"; roomIdHex: string; fragment: string | undefined }
  | { kind: "named"; name: string };

function parseRoute(): Route {
  const path = window.location.pathname;
  const unlisted = path.match(/^\/r\/([0-9a-f]{32})\/?$/);
  // The key comes from a handoff, the address (cleared on the spot), or this
  // tab's saved state — never left sitting in the address bar.
  if (unlisted) return { kind: "unlisted", roomIdHex: unlisted[1], fragment: takeRoomKey(unlisted[1]) };
  // Old-style links stay valid indefinitely; people have pasted them into
  // chats and those should not rot.
  const legacyNamed = path.match(/^\/n\/([a-z0-9-]+)\/?$/);
  if (legacyNamed) return { kind: "named", name: legacyNamed[1] };
  // Named rooms now live at the root: /copper-lantern. The server only serves
  // the shell here for paths that pass name validation, so anything reaching
  // this point is already name-shaped.
  const bare = path.match(/^\/([a-z0-9-]+)\/?$/);
  if (bare) return { kind: "named", name: bare[1] };
  // A shared room opened from inside the app sits at `/` with its name in
  // memory, so the name never has to enter the address.
  const handedOver = path === "/" ? takePendingNamedRoom() : null;
  if (handedOver) return { kind: "named", name: handedOver };
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
