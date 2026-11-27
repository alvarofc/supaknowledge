import { Check, Copy, Download, Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { slugify } from "@/lib/format";
import { recapText } from "@/lib/recap";
import type { Recap } from "@/lib/recap";
import { renderRecapPng } from "./recap-image";

/** Download or copy the recap card as a PNG (drawn client side), or copy it as text for Slack. */
export function RecapShareActions({ recap, scopeName }: { recap: Recap; scopeName: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"download" | "image" | null>(null);
  const [copied, setCopied] = useState<"image" | "text" | null>(null);

  const flash = (what: "image" | "text") => {
    setCopied(what);
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
  };

  const download = async () => {
    setBusy("download");
    try {
      const blob = await renderRecapPng(recap, scopeName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recap-${slugify(scopeName) || "space"}-${recap.month}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the image");
    } finally {
      setBusy(null);
    }
  };

  const copyImage = async () => {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      toast.error("This browser cannot copy images. Use Download PNG instead.");
      return;
    }
    setBusy("image");
    try {
      // pass the promise itself: Safari only allows clipboard writes that start inside the click
      await navigator.clipboard.write([new ClipboardItem({ "image/png": renderRecapPng(recap, scopeName) })]);
      flash("image");
    } catch {
      toast.error("Could not copy the image. Use Download PNG instead.");
    } finally {
      setBusy(null);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(recapText(recap, scopeName));
      flash("text");
    } catch {
      toast.error("Could not copy to the clipboard.");
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={download} pending={busy === "download"}>
        <Download /> Download PNG
      </Button>
      <Button size="sm" onClick={copyImage} pending={busy === "image"}>
        {copied === "image" ? <Check className="text-ok" /> : <ImageIcon />} {copied === "image" ? "Image copied" : "Copy image"}
      </Button>
      <Button size="sm" onClick={copyText}>
        {copied === "text" ? <Check className="text-ok" /> : <Copy />} {copied === "text" ? "Text copied" : "Copy for Slack"}
      </Button>
    </div>
  );
}
