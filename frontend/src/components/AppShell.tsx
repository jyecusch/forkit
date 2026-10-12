import { useLiveQuery } from "@tanstack/react-db"
import { Outlet, useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo } from "react"
import { usePreferences, useSession } from "@/app/hooks"
import { useService } from "@/app/services"
import { GraphData } from "@/services/GraphData"
import { TooltipProvider } from "@/components/ui/tooltip"
import { reposCollection } from "@/data/collections"
import type { Repo, RepoId } from "@/model/model.gen"
import { RepoView } from "./RepoView"
import { Toaster } from "./Toaster"

/** Applies the session and preferences to the window and shows the active view. */
export const AppShell = () => {
  const navigate = useNavigate()
  const session = useSession()
  const preferences = usePreferences()

  // The session decides which repository is shown, so it survives restarts
  // and changes made elsewhere, such as opening a repository.
  const activeRepo = session?.activeRepoId
  useEffect(() => {
    void navigate(activeRepo ? { to: "/repos/$repoId", params: { repoId: activeRepo } } : { to: "/" })
  }, [navigate, activeRepo])

  // A layout effect, so the theme is applied before any child's passive
  // effects read colours from it, such as the graph canvas palette.
  useLayoutEffect(() => {
    if (!preferences) return
    document.documentElement.dataset.theme = preferences.appearance.theme
    document.documentElement.style.setProperty("--app-font-size", `${preferences.appearance.fontSize}px`)
  }, [preferences])

  const graphData = useService(GraphData)
  const openRepos = useMemo(() => session?.openRepos.map((open) => open.id) ?? [], [session])
  useEffect(() => graphData.retain(openRepos), [graphData, openRepos])

  return (
    <TooltipProvider>
      <div className="relative flex h-full flex-col">
        <Outlet />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

/** Shows one repository, once its entities have arrived. */
export const RepoRoute = ({ repoId }: { repoId: RepoId }) => {
  const session = useSession()
  const preferences = usePreferences()
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })
  const repo: Repo | undefined = repos.find((r) => r.id === repoId)
  if (!repo || !preferences) {
    return <div className="flex-1 bg-sidebar" />
  }
  return <RepoView key={repo.id} repo={repo} openRepo={session?.openRepos.find((open) => open.id === repo.id)} preferences={preferences} />
}
