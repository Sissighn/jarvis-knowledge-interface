import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JARVIS — Personal Knowledge Interface",
  description: "A local-first interface for Notion knowledge, semantic graph exploration, and focused daily context.",
  applicationName: "JARVIS",
  keywords: ["Notion", "knowledge graph", "local-first", "TF-IDF", "personal knowledge management"],
  authors: [{ name: "Setayesh", url: "https://github.com/Sissighn" }],
  openGraph: {
    title: "JARVIS — Personal Knowledge Interface",
    description: "Explore Notion knowledge as an interactive semantic graph.",
    images: [{ url: "/jarvis-interface.png", width: 1668, height: 943, alt: "JARVIS knowledge interface" }],
    type: "website",
  },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
