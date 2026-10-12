import { CircleAlert, X } from "lucide-react"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { dismiss, useNotice, type Notice } from "@/app/notifications"
import { cn } from "@/lib/utils"

const visibleFor = 8000
/** Notices with an action stay longer, so there is time to take it. */
const visibleWithActionFor = 12000

/** Shows the latest notice in the window's bottom-right corner. */
export const Toaster = () => {
  const notice = useNotice()
  // Rendered outside the app root so it stays visible and clickable over dialogs.
  return notice ? createPortal(<Toast key={notice.id} notice={notice} />, document.body) : null
}

const Toast = ({ notice }: { notice: Notice }) => {
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (hovered) return
    const timer = setTimeout(() => dismiss(notice.id), notice.duration ?? (notice.action ? visibleWithActionFor : visibleFor))
    return () => clearTimeout(timer)
  }, [notice, hovered])
  return (
    <div
      data-toast
      role={notice.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "pointer-events-auto fixed right-5 bottom-5 z-[60] flex max-w-[min(320px,calc(100vw-40px))] items-start gap-2.5 rounded-lg border bg-popover py-2.5 pr-2 pl-3 text-[13px] shadow-xl select-text",
        notice.tone === "error" && "border-destructive/40",
      )}
    >
      {notice.tone === "error" && <CircleAlert aria-hidden className="mt-0.5 size-4 flex-none text-destructive" />}
      <span className="min-w-0 flex-1 py-px break-words">{notice.message}</span>
      {notice.action && (
        <button
          className="flex-none py-px font-medium text-primary"
          onClick={() => {
            notice.action?.run()
            dismiss(notice.id)
          }}
        >
          {notice.action.label}
        </button>
      )}
      {(notice.duration ?? visibleFor) >= 3000 && (
        <button
          aria-label="Dismiss"
          onClick={() => dismiss(notice.id)}
          className="-my-0.5 flex size-6 flex-none items-center justify-center rounded text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
