import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Website Task Completion Study",
  description: "Collect task-completion traces for website usability timing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
