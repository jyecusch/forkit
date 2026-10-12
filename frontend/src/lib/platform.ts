import type { CSSProperties } from "react"

/** macOS draws the window controls inside our content; elsewhere they sit in a native title bar. */
export const isMac = navigator.userAgent.includes("Mac")

/** Wails treats elements with these styles as the window's drag handle, or not. */
export const dragRegion = { "--wails-draggable": "drag" } as CSSProperties
export const noDrag = { "--wails-draggable": "no-drag" } as CSSProperties

export const isWindows = navigator.userAgent.includes("Windows")
