import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { AppShell, Workspace } from "@/components/AppShell"

const rootRoute = createRootRoute({ component: AppShell })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Workspace })

/** The window's view. The session decides what it shows; see Workspace. */
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
