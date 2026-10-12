import { useState, type ReactNode } from "react"
import { useRun } from "@/app/hooks"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import type { Preferences as PreferencesData } from "@/model/model.gen"
import { Preferences, type PreferencePath, type PreferenceValue } from "@/services/Preferences"
import { darkThemes, lightThemes } from "@/lib/themes"
import { cn } from "@/lib/utils"

interface SettingsDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly preferences: PreferencesData
}

const fontSizes = [11, 12, 13, 14, 15, 16]

/** Edits preferences. Every change is saved immediately. */
export const SettingsDialog = ({ open, onOpenChange, preferences: p }: SettingsDialogProps) => {
  const run = useRun()
  const set = <P extends PreferencePath>(path: P, value: PreferenceValue<P>) =>
    void run(Preferences.use((prefs) => prefs.set(path, value)))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-h-[76vh] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="px-5 pt-5 pb-1">
          <DialogTitle>Preferences</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 pt-3 pb-5 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-16px),transparent)]">
          <Group title="Appearance">
            <Row label="Appearance">
              <Segmented
                label="Appearance"
                value={p.appearance.appearance}
                options={{ system: "System", light: "Light", dark: "Dark" }}
                onChange={(v) => set("appearance.appearance", v)}
              />
            </Row>
            <Row label="Light theme">
              <Choice value={p.appearance.lightTheme} options={lightThemes} onChange={(v) => set("appearance.lightTheme", v)} />
            </Row>
            <Row label="Dark theme">
              <Choice value={p.appearance.darkTheme} options={darkThemes} onChange={(v) => set("appearance.darkTheme", v)} />
            </Row>
            <Row label="Font size">
              <Choice
                value={String(p.appearance.fontSize)}
                options={Object.fromEntries(fontSizes.map((size) => [String(size), `${size} px`]))}
                onChange={(v) => set("appearance.fontSize", Number(v))}
              />
            </Row>
            <Row label="Dates">
              <Choice
                value={p.appearance.dateFormat}
                options={{ relative: "Relative", absolute: "Absolute", iso: "ISO 8601" }}
                onChange={(v) => set("appearance.dateFormat", v)}
              />
            </Row>
          </Group>

          <Group title="Graph">
            <Row label="Order">
              <Choice value={p.graph.order} options={{ topo: "Topological", date: "Date" }} onChange={(v) => set("graph.order", v)} />
            </Row>
            <Row label="Show remote branches" end>
              <Switch checked={p.graph.showRemoteBranches} onCheckedChange={(v) => set("graph.showRemoteBranches", v)} />
            </Row>
            <Row label="Show tags" end>
              <Switch checked={p.graph.showTags} onCheckedChange={(v) => set("graph.showTags", v)} />
            </Row>
            <Row label="Visibility of other branches">
              <OpacitySlider value={p.graph.dimmedOpacity} onCommit={(v) => set("graph.dimmedOpacity", v)} />
            </Row>
          </Group>

          <Group title="Diffs">
            <Row label="Ignore whitespace" hint="Lines that differ only in spacing show as unchanged." end>
              <Switch checked={p.diff.ignoreWhitespace} onCheckedChange={(v) => set("diff.ignoreWhitespace", v)} />
            </Row>
          </Group>

          <Group title="Git">
            <Row label="Git binary" hint="Empty uses git from PATH. Applies after restart.">
              <TextInput key={p.git.binaryPath} value={p.git.binaryPath} placeholder="git" onCommit={(v) => set("git.binaryPath", v)} />
            </Row>
            <Row label="Maintain commit-graph" hint="Speeds up history on large repositories." end>
              <Switch checked={p.git.maintainCommitGraph} onCheckedChange={(v) => set("git.maintainCommitGraph", v)} />
            </Row>
          </Group>

          <Group title="Behaviour">
            <Row label="Checking out with uncommitted changes">
              <Choice
                value={p.behaviour.dirtyCheckout}
                options={{ ask: "Ask", stash: "Stash and reapply", carry: "Bring changes" }}
                onChange={(v) => set("behaviour.dirtyCheckout", v)}
              />
            </Row>
          </Group>

          <Group title="Telemetry">
            <Row label="Traces" hint="Local keeps traces on this machine. Applies after restart.">
              <Choice
                value={p.telemetry.mode}
                options={{ local: "Local file", otlp: "OTLP endpoint" }}
                onChange={(v) => set("telemetry.mode", v)}
              />
            </Row>
            {p.telemetry.mode === "otlp" && (
              <Row label="OTLP endpoint">
                <TextInput key={p.telemetry.otlpEndpoint} value={p.telemetry.otlpEndpoint} placeholder="http://localhost:4318" onCommit={(v) => set("telemetry.otlpEndpoint", v)} />
              </Row>
            )}
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col">
    <h3 className="text-xs font-medium text-subtle-foreground">{title}</h3>
    {children}
  </section>
)

/** Labels on the left, every control in one 200 px column on the right; switches sit at its end. */
const Row = ({ label, hint, end = false, children }: { label: string; hint?: string; end?: boolean; children: ReactNode }) => (
  <div className="grid min-h-9 grid-cols-[minmax(0,1fr)_200px] items-center gap-4 py-1">
    <div className="flex min-w-0 flex-col">
      <span>{label}</span>
      {hint && <span className="text-xs text-subtle-foreground">{hint}</span>}
    </div>
    <div className={end ? "flex justify-end" : "flex"}>{children}</div>
  </div>
)

/** A few mutually exclusive options side by side, filling the control column. */
const Segmented = <V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: V
  options: Record<V, string>
  onChange: (value: V) => void
}) => (
  <div role="radiogroup" aria-label={label} className="flex h-7 w-full rounded-md bg-foreground/[0.06] p-0.5">
    {(Object.keys(options) as Array<V>).map((key) => (
      <button
        key={key}
        role="radio"
        aria-checked={key === value}
        onClick={() => onChange(key)}
        className={cn(
          "flex-1 rounded-[5px] text-xs font-medium",
          key === value ? "bg-background text-foreground shadow-sm" : "text-subtle-foreground hover:text-foreground",
        )}
      >
        {options[key]}
      </button>
    ))}
  </div>
)

const Choice = <V extends string>({ value, options, onChange }: { value: V; options: Record<V, string>; onChange: (value: V) => void }) => (
  <Select value={value} onValueChange={(v) => onChange(v as V)}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {(Object.keys(options) as Array<V>).map((key) => (
        <SelectItem key={key} value={key}>
          {options[key]}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)

/**
 * A text field that saves when it loses focus or Enter is pressed. Callers
 * key it on value, so a change made elsewhere replaces the draft.
 */
const TextInput = ({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (value: string) => void }) => {
  const [draft, setDraft] = useState(value)
  const [committed, setCommitted] = useState(value)
  const commit = () => {
    if (draft === committed) return
    setCommitted(draft)
    onCommit(draft)
  }
  return (
    <Input
      className="w-full"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && commit()}
    />
  )
}

/** A slider that follows the pointer while dragging and saves on release. */
const OpacitySlider = ({ value, onCommit }: { value: number; onCommit: (value: number) => void }) => {
  const [draft, setDraft] = useState<number>()
  return (
    <div className="flex w-full items-center gap-3">
      <Slider
        className="flex-1"
        min={0.1}
        max={0.8}
        step={0.05}
        value={[draft ?? value]}
        onValueChange={([v]) => setDraft(v)}
        onValueCommit={([v]) => {
          setDraft(undefined)
          if (v !== undefined && v !== value) onCommit(v)
        }}
      />
      <span className="w-9 text-right text-xs text-subtle-foreground tabular-nums">{Math.round((draft ?? value) * 100)}%</span>
    </div>
  )
}
