import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { router } from "@/app/router"
import { ServicesProvider } from "@/app/services"
import { appRuntime } from "@/services/runtime"
import "./styles.css"

const services = await appRuntime.context()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>
  </StrictMode>,
)
