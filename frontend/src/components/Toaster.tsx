import { CircleAlert, X } from "lucide-react"
import { useEffect } from "react"
import { dismiss, useNotice } from "@/app/notifications"
import { cn } from "@/lib/utils"

const visibleFor = 8000

/** Shows the latest notice in the window's bottom-right corner. */
export const Toaster = () => {
  const notice = useNotice()
  useEffect(() => {
    if (!notice || notice.action) return
    const timer = setTimeout(() => dismiss(notice.id), notice.duration ?? visibleFor)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "fixed right-5 bottom-5 z-50 flex max-w-[min(420px,calc(100vw-40px))] items-start gap-2.5 rounded-lg border bg-card py-2.5 pr-2 pl-3 text-[13px] shadow-xl select-text",
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
      <button
        aria-label="Dismiss"
        onClick={() => dismiss(notice.id)}
        className="-my-0.5 flex size-6 flex-none items-center justify-center rounded text-subtle-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
