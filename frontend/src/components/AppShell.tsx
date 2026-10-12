import { useLiveQuery } from "@tanstack/react-db"
import { Outlet, useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo, useState } from "react"
import { usePreferences, useRun, useSession } from "@/app/hooks"
import { useService } from "@/app/services"
import { GraphData } from "@/services/GraphData"
import { TooltipProvider } from "@/components/ui/tooltip"
import { reposCollection } from "@/data/collections"
import type { Repo, RepoId } from "@/model/model.gen"
import { Commands } from "@/services/Commands"
import { RepoTabs } from "./RepoTabs"
import { RepoView } from "./RepoView"
import { SettingsDialog } from "./SettingsDialog"
import { Toaster } from "./Toaster"

/** The window frame: repository tabs above the active view. */
export const AppShell = () => {
  const run = useRun()
  const navigate = useNavigate()
  const session = useSession()
  const preferences = usePreferences()
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })

  const orderedRepos = useMemo(() => {
    const order = session?.openRepos.map((open) => open.id) ?? []
    return repos.filter((repo) => order.includes(repo.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  }, [repos, session])

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
  useEffect(() => graphData.retain(orderedRepos.map((repo) => repo.id)), [graphData, orderedRepos])

  const select = (repo: RepoId) => void run(Commands.use((commands) => commands.selectRepository(repo)))
  return (
    <TooltipProvider>
      <div className="relative flex h-full flex-col">
        <RepoTabs
          repos={orderedRepos}
          active={activeRepo}
          onSelect={select}
          onClose={(repo) => void run(Commands.use((commands) => commands.closeRepository(repo)))}
          onOpen={() => void run(Commands.use((commands) => commands.openRepository()))}
          onReorder={(order) => void run(Commands.use((commands) => commands.reorderRepositories(order)))}
        />
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })
  const repo: Repo | undefined = repos.find((r) => r.id === repoId)
  if (!repo || !preferences) {
    return <div className="flex-1" />
  }
  return (
    <>
      <RepoView
        key={repo.id}
        repo={repo}
        openRepo={session?.openRepos.find((open) => open.id === repo.id)}
        preferences={preferences}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} preferences={preferences} />
    </>
  )
}
