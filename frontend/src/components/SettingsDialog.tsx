import { useState, type ReactNode } from "react"
import { useRun } from "@/app/hooks"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import type { Preferences as PreferencesData } from "@/model/model.gen"
import { Preferences, type PreferencePath, type PreferenceValue } from "@/services/Preferences"

interface SettingsDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly preferences: PreferencesData
}

/** Edits preferences. Every change is saved immediately. */
export const SettingsDialog = ({ open, onOpenChange, preferences: p }: SettingsDialogProps) => {
  const run = useRun()
  const set = <P extends PreferencePath>(path: P, value: PreferenceValue<P>) =>
    void run(Preferences.use((prefs) => prefs.set(path, value)))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>Changes apply straight away. They are stored in Forkit's preferences file, which you can also edit by hand.</DialogDescription>
        </DialogHeader>

        <Group title="Appearance">
          <Row label="Theme">
            <Choice
              value={p.appearance.theme}
              options={{ "tokyo-night": "Tokyo Night", "tokyo-night-day": "Tokyo Night Day" }}
              onChange={(v) => set("appearance.theme", v)}
            />
          </Row>
          <Row label="Font size">
            <NumberInput key={p.appearance.fontSize} value={p.appearance.fontSize} min={10} max={20} onCommit={(v) => set("appearance.fontSize", v)} />
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
          <Row label="Show remote branches">
            <Switch checked={p.graph.showRemoteBranches} onCheckedChange={(v) => set("graph.showRemoteBranches", v)} />
          </Row>
          <Row label="Show tags">
            <Switch checked={p.graph.showTags} onCheckedChange={(v) => set("graph.showTags", v)} />
          </Row>
          <Row label="Dim other history to">
            <OpacitySlider value={p.graph.dimmedOpacity} onCommit={(v) => set("graph.dimmedOpacity", v)} />
          </Row>
        </Group>

        <Group title="Git">
          <Row label="Git binary" hint="Empty uses git from PATH. Applies after restart.">
            <TextInput key={p.git.binaryPath} value={p.git.binaryPath} placeholder="git" onCommit={(v) => set("git.binaryPath", v)} />
          </Row>
          <Row label="Maintain commit-graph" hint="Speeds up history on large repositories.">
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
      </DialogContent>
    </Dialog>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-[11px] font-semibold tracking-wider text-subtle-foreground uppercase">{title}</h3>
    {children}
  </section>
)

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="flex flex-col">
      <span>{label}</span>
      {hint && <span className="text-xs text-subtle-foreground">{hint}</span>}
    </div>
    {children}
  </div>
)

const Choice = <V extends string>({ value, options, onChange }: { value: V; options: Record<V, string>; onChange: (value: V) => void }) => (
  <Select value={value} onValueChange={(v) => onChange(v as V)}>
    <SelectTrigger className="w-44">
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
      className="w-56"
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
    <Slider
      className="w-40"
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
  )
}

/** Callers key it on value, so a change made elsewhere replaces what is shown. */
const NumberInput = ({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (value: number) => void }) => (
  <Input
    type="number"
    className="w-20"
    defaultValue={value}
    min={min}
    max={max}
    onBlur={(event) => {
      const next = Number(event.target.value)
      if (next !== value && next >= min && next <= max) onCommit(next)
    }}
  />
)
