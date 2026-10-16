/**
 * The folder name git gives a clone of url: the last part of its path,
 * without ".git". Empty when the URL has no path to name it by.
 */
export const cloneFolderName = (url: string): string => {
  const trimmed = url.trim().replace(/[/\\]+$/, "")
  const path = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
  return (path.split(/[/\\:]/).at(-1) ?? "").replace(/\.git$/, "")
}
