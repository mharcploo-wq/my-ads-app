import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ads Control — Dashboard แคมเปญ Meta Ads",
  description: "เปรียบเทียบผลแคมเปญของ Claude / Manus / ChatGPT ในบัญชีโฆษณาเดียวกัน",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
