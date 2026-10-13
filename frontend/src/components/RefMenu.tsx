import { ArrowRightLeft, Copy, Focus, FolderPlus, Trash2 } from "lucide-react"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import { branchFamily } from "@/lib/branches"
import { baseName } from "@/lib/format"
import type { Ref, Worktree } from "@/model/model.gen"

/** What a ref's menu can do; each action is given the ref, or refs, to act on. */
export interface RefActions {
  /** Checks a ref out, or switches to the worktree that has it. */
  readonly open: (ref: Ref) => void
  readonly newWorktree: (base: Ref) => void
  readonly emphasize: (ref: Ref) => void
  readonly deleteBranches: (refs: ReadonlyArray<Ref>) => void
}

interface RefMenuProps {
  readonly target: Ref
  readonly refs: ReadonlyArray<Ref>
  /** The ref is checked out in the active worktree. */
  readonly current: boolean
  /** Another worktree that has the ref checked out. */
  readonly elsewhere: Worktree | undefined
  /** The keys that check the ref out where the menu was opened, if any. */
  readonly openShortcut?: string
  readonly actions: RefActions
}

/**
 * The context menu of a branch, tag or stash, the same in the sidebar and
 * the graph. The ref is named once at the top so items stay short: actions
 * that switch to it, then ones that look at it, then deletion.
 */
export const RefMenu = ({ target, refs, current, elsewhere, openShortcut, actions }: RefMenuProps) => (
  <ContextMenuContent className="w-60">
    <ContextMenuLabel className="truncate text-xs text-subtle-foreground" title={target.shortName}>
      {target.shortName}
    </ContextMenuLabel>
    <ContextMenuSeparator />
    <ContextMenuItem disabled={current} onSelect={() => actions.open(target)}>
      <ArrowRightLeft />
      {elsewhere
        ? `Switch to ${baseName(elsewhere.path)}`
        : target.kind === "remoteBranch"
          ? "Check out as local branch…"
          : "Check out"}
      {openShortcut && <ContextMenuShortcut>{openShortcut}</ContextMenuShortcut>}
    </ContextMenuItem>
    {target.kind !== "stash" && (
      <ContextMenuItem onSelect={() => actions.newWorktree(target)}>
        <FolderPlus />
        New worktree from here…
      </ContextMenuItem>
    )}
    <ContextMenuSeparator />
    <ContextMenuItem onSelect={() => actions.emphasize(target)}>
      <Focus />
      Emphasize history
    </ContextMenuItem>
    <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(target.shortName)}>
      <Copy />
      Copy name
    </ContextMenuItem>
    <DeleteItems target={target} refs={refs} onDelete={actions.deleteBranches} />
  </ContextMenuContent>
)

/**
 * Deletes the ref or any of its namesakes (see branchFamily): one item when
 * there is one choice, otherwise a submenu. A checked-out branch can't be
 * deleted, so it is left out.
 */
const DeleteItems = ({ target, refs, onDelete }: { target: Ref; refs: ReadonlyArray<Ref>; onDelete: (refs: ReadonlyArray<Ref>) => void }) => {
  const deletable = branchFamily(target, refs).filter((ref) => !ref.checkedOutInWorktreeId)
  const [only] = deletable
  if (!only) return null
  if (deletable.length === 1) {
    return (
      <>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete([only])}>
          <Trash2 />
          Delete {whereLabel(only).toLowerCase()}
        </ContextMenuItem>
      </>
    )
  }
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger className="h-7 gap-2 rounded-md py-0 text-destructive focus:bg-destructive/10 focus:text-destructive data-[state=open]:bg-destructive/10 data-[state=open]:text-destructive [&_svg]:text-destructive!">
          <Trash2 />
          Delete
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-44 rounded-[10px]">
          {deletable.map((ref) => (
            <ContextMenuItem key={ref.id} variant="destructive" onSelect={() => onDelete([ref])}>
              <span className="truncate" title={ref.shortName}>
                {whereLabel(ref)}
              </span>
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(deletable)}>
            {deletable.some((ref) => ref.kind === "localBranch") ? "Everywhere" : "On all remotes"}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  )
}

/** Where a branch lives: "Local branch", or "On origin" for a remote's. */
const whereLabel = (ref: Ref) => (ref.kind === "localBranch" ? "Local branch" : `On ${ref.shortName.slice(0, ref.shortName.indexOf("/"))}`)
