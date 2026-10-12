import { X } from "lucide-react"
import { useEffect } from "react"
import { dismiss, useNotice } from "@/app/notifications"
import { cn } from "@/lib/utils"

const visibleFor = 8000

/** Shows the latest notice above the status bar. */
export const Toaster = () => {
  const notice = useNotice()
  useEffect(() => {
    if (!notice || notice.action) return
    const timer = setTimeout(() => dismiss(notice.id), visibleFor)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "absolute bottom-11 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-3.5 rounded-lg border bg-card px-3.5 py-2.5 shadow-xl select-text",
        notice.tone === "error" && "border-destructive/50",
      )}
    >
      <span>{notice.message}</span>
      {notice.action && (
        <button
          className="font-medium text-primary"
          onClick={() => {
            notice.action?.run()
            dismiss(notice.id)
          }}
        >
          {notice.action.label}
        </button>
      )}
      <button aria-label="Dismiss" onClick={() => dismiss(notice.id)} className="text-subtle-foreground">
        <X className="size-3" />
      </button>
    </div>
  )
}
