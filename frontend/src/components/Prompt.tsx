import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

/** A question with a few answers; Cancel is always offered. */
export interface PromptSpec {
  readonly title: string
  readonly message: string
  readonly actions: ReadonlyArray<{
    readonly label: string
    readonly tone?: "primary" | "destructive"
    readonly run: () => void
  }>
}

export const Prompt = ({ spec, onClose }: { spec: PromptSpec | undefined; onClose: () => void }) => (
  <Dialog open={spec !== undefined} onOpenChange={(open) => !open && onClose()}>
    {spec && (
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{spec.title}</DialogTitle>
          <DialogDescription>{spec.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {spec.actions.map((action) => (
            <Button
              key={action.label}
              variant={action.tone === "primary" ? "default" : action.tone === "destructive" ? "destructive" : "outline"}
              onClick={() => {
                onClose()
                action.run()
              }}
            >
              {action.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    )}
  </Dialog>
)
