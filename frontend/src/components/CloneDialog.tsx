import { useLiveQuery } from "@tanstack/react-db"
import { Effect, Option } from "effect"
import { LoaderCircle } from "lucide-react"
import { useRef, useState } from "react"
import { useRun, useSession } from "@/app/hooks"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { clonesCollection } from "@/data/collections"
import { cloneFolderName } from "@/lib/cloneUrl"
import { Commands } from "@/services/Commands"
import { useRestoreFocus } from "./Chrome"

interface CloneDialogProps {
  readonly open: boolean
  readonly onClose: () => void
}

/** Clones a repository from a URL into a new folder, then opens it. */
export const CloneDialog = ({ open, onClose }: CloneDialogProps) => {
  const run = useRun()
  const session = useSession()
  const [url, setUrl] = useState("")
  const [chosenParent, setChosenParent] = useState<string>()
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string>()
  const urlInput = useRef<HTMLInputElement>(null)
  const restoreFocus = useRestoreFocus()

  const parent = chosenParent ?? session?.cloneDirectory
  const name = cloneFolderName(url)
  const path = parent && name ? `${parent}/${name}` : ""
  const progress = useLiveQuery({ query: (q) => q.from({ clone: clonesCollection }) }).data.find((clone) => clone.path === path)?.progress

  const clone = async () => {
    if (!path || cloning) return
    setCloning(true)
    setError(undefined)
    const failure = Option.flatten(
      await run(
        Commands.use((commands) => commands.cloneRepository(url, path)).pipe(
          Effect.as(Option.none<string>()),
          Effect.catch((error) =>
            Effect.succeed(error._tag === "BackendError" && error.code === "Cancelled" ? Option.none() : Option.some(error.message)),
          ),
        ),
      ),
    )
    setCloning(false)
    if (Option.isSome(failure)) {
      setError(failure.value)
    } else {
      setUrl("")
      onClose()
    }
  }

  const close = () => {
    if (cloning) void run(Commands.use((commands) => commands.cancelClone(path)))
    setError(undefined)
    onClose()
  }

  const choose = async () => {
    const chosen = Option.flatten(await run(Commands.use((commands) => commands.chooseCloneDirectory())))
    if (Option.isSome(chosen)) setChosenParent(chosen.value)
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="sm:max-w-[480px]"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          urlInput.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span>URL</span>
          <Input
            ref={urlInput}
            value={url}
            disabled={cloning}
            placeholder="https://github.com/owner/repository.git"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setUrl(event.target.value)
              setError(undefined)
            }}
            onKeyDown={(event) => event.key === "Enter" && void clone()}
          />
        </label>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span>Location</span>
          <div className="flex h-7 items-center gap-2">
            {/* Right-to-left so a long path is cut at its start, keeping the folder names that tell it apart. */}
            <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-secondary-foreground [direction:rtl]" title={path || undefined}>
              <bdi>{parent ? `${parent}/${name || "…"}` : "Choose a folder to clone into"}</bdi>
            </span>
            <Button variant="ghost" size="sm" className="text-primary" disabled={cloning} onClick={() => void choose()}>
              Choose…
            </Button>
          </div>
        </div>
        {cloning && (
          <div className="flex flex-col gap-1.5" role="status">
            <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: progress && progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : "0%" }}
              />
            </div>
            <span className="text-xs text-secondary-foreground">
              {progress ? `${progress.phase}… ${progress.total > 0 ? Math.floor((progress.current / progress.total) * 100) : 0}%` : "Connecting…"}
            </span>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!path} aria-busy={cloning} onClick={() => void clone()}>
            {cloning && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
            {cloning ? "Cloning…" : "Clone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
