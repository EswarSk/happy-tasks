import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Happy Tasks",
    short_name: "Tasks",
    description: "A collaborative task workspace for projects, dependencies, and files.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F8F8F8",
    theme_color: "#111111",
    icons: [
      { src: "/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
    screenshots: [
      { src: "/screenshot-wide.png", sizes: "1440x900", type: "image/png", form_factor: "wide" },
      { src: "/screenshot-narrow.png", sizes: "390x844", type: "image/png" },
    ],
  };
}
