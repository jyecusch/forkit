import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="flex h-full items-center justify-center text-muted-foreground">Forkit</main>
  </StrictMode>,
)
