import { createMemoryHistory, createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router"
import { AppShell, RepoRoute } from "@/components/AppShell"
import { Welcome } from "@/components/Welcome"
import { RepoId } from "@/model/model.gen"

const rootRoute = createRootRoute({ component: AppShell })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Welcome })

const repoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$repoId",
  component: () => <RepoRoute repoId={RepoId.make(useParams({ from: "/repos/$repoId" }).repoId)} />,
})

/** The window's views. The session decides which is shown; see AppShell. */
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, repoRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
