import { useLiveQuery } from "@tanstack/react-db"
import { Outlet, useNavigate } from "@tanstack/react-router"
import { useEffect, useLayoutEffect, useMemo, useState } from "react"
import { usePreferences, useResolvedTheme, useSession } from "@/app/hooks"
import { dismissActions } from "@/app/notifications"
import { setPreferencesOpen, usePreferencesOpen } from "@/app/preferencesDialog"
import { useService } from "@/app/services"
import { useShortcuts } from "@/app/useShortcuts"
import { GraphData } from "@/services/GraphData"
import { TooltipProvider } from "@/components/ui/tooltip"
import { reposCollection } from "@/data/collections"
import type { Repo, RepoId } from "@/model/model.gen"
import { Chrome } from "./Chrome"
import { RepoTabs } from "./RepoTabs"
import { RepoView } from "./RepoView"
import { SettingsDialog } from "./SettingsDialog"
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
  const theme = useResolvedTheme()
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useLayoutEffect(() => {
    if (!preferences) return
    document.documentElement.style.setProperty("--app-font-size", `${preferences.appearance.fontSize}px`)
  }, [preferences])

  const graphData = useService(GraphData)
  const openRepos = useMemo(() => session?.openRepos.map((open) => open.id) ?? [], [session])
  useEffect(() => graphData.retain(openRepos), [graphData, openRepos])
  useShortcuts(openRepos, activeRepo)
  useEffect(dismissActions, [activeRepo])
  const preferencesOpen = usePreferencesOpen()

  return (
    <TooltipProvider>
      <div className="relative flex h-full flex-col">
        <Outlet />
        <Toaster />
        {preferences && <SettingsDialog open={preferencesOpen} onOpenChange={setPreferencesOpen} preferences={preferences} />}
      </div>
    </TooltipProvider>
  )
}

/**
 * Shows one repository, once its entities have arrived. Every repository
 * shown since it was opened stays mounted, hidden behind the active one, so
 * switching tabs keeps each one's scroll position, selection and sidebar.
 */
export const RepoRoute = ({ repoId }: { repoId: RepoId }) => {
  const session = useSession()
  const preferences = usePreferences()
  const { data: repos } = useLiveQuery({ query: (q) => q.from({ repo: reposCollection }) })
  const byId = new Map<string, Repo>(repos.map((repo) => [repo.id, repo]))
  // A repository is mounted when first shown, then kept.
  const [shown, setShown] = useState<ReadonlySet<RepoId>>(new Set([repoId]))
  if (!shown.has(repoId)) setShown(new Set([...shown, repoId]))
  // The kept repositories stay mounted even while the active one loads.
  const loading = !byId.has(repoId) || !preferences
  return (
    <Chrome tabs={<RepoTabs />} sidebar={loading && <SidebarSkeleton />}>
      {loading && <div className="h-10 flex-none border-b" />}
      {preferences &&
        session?.openRepos.map((open) => {
          const repo = byId.get(open.id)
          return (
            repo &&
            shown.has(repo.id) && (
              <RepoView key={repo.id} repo={repo} openRepo={open} preferences={preferences} active={!loading && open.id === repoId} />
            )
          )
        })}
    </Chrome>
  )
}

/** Placeholder rows on the navigator's guides while a repository loads. */
const SidebarSkeleton = () => (
  <div aria-hidden className="flex flex-col px-4 pt-11">
    {[56, 72, 48, 64, 40].map((width, i) => (
      <div key={i} className="flex h-7 items-center gap-2">
        <span className="size-3.5 rounded bg-foreground/[0.06]" />
        <span className="h-2 rounded bg-foreground/[0.06]" style={{ width: `${width}%` }} />
      </div>
    ))}
  </div>
)
