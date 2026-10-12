import type { DarkTheme, LightTheme } from "@/model/model.gen"

/** Theme names as shown, in the order offered, light and dark apart. */
export const lightThemes: Record<LightTheme, string> = {
  "tokyo-night-day": "Tokyo Night Day",
  "catppuccin-latte": "Catppuccin Latte",
  "github-light": "GitHub Light",
  "gruvbox-light": "Gruvbox Light",
  "one-light": "One Light",
  "rose-pine-dawn": "Rosé Pine Dawn",
  "solarized-light": "Solarized Light",
}

export const darkThemes: Record<DarkTheme, string> = {
  "tokyo-night": "Tokyo Night",
  "catppuccin-frappe": "Catppuccin Frappé",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  "catppuccin-mocha": "Catppuccin Mocha",
  dracula: "Dracula",
  "github-dark": "GitHub Dark",
  "gruvbox-dark": "Gruvbox Dark",
  nord: "Nord",
  "one-dark": "One Dark",
  "rose-pine": "Rosé Pine",
  "rose-pine-moon": "Rosé Pine Moon",
  "solarized-dark": "Solarized Dark",
}
