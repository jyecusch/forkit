import { Context } from "effect"
import { createContext, useContext, type ReactNode } from "react"
import type { AppServices } from "@/services/runtime"

const ServicesContext = createContext<Context.Context<AppServices> | undefined>(undefined)

/** Makes the built app services available to components. */
export const ServicesProvider = ({ services, children }: { services: Context.Context<AppServices>; children: ReactNode }) => (
  <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
)

/** Returns a service for its synchronous members, such as GraphData.peek. */
export const useService = <I extends AppServices, S>(tag: Context.Key<I, S>): S => {
  const services = useContext(ServicesContext)
  if (!services) {
    throw new Error("useService called outside ServicesProvider")
  }
  return Context.get(services, tag)
}
