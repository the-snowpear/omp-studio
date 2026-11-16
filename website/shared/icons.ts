// Icons used across the three concepts. Lucide strokes for product chrome,
// hand-drawn marks for brands Lucide does not carry.
import activity from "lucide-static/icons/activity.svg?raw";
import arrowDown from "lucide-static/icons/arrow-down.svg?raw";
import arrowLeft from "lucide-static/icons/arrow-left.svg?raw";
import arrowRight from "lucide-static/icons/arrow-right.svg?raw";
import arrowUp from "lucide-static/icons/arrow-up.svg?raw";
import atSign from "lucide-static/icons/at-sign.svg?raw";
import bot from "lucide-static/icons/bot.svg?raw";
import boxes from "lucide-static/icons/boxes.svg?raw";
import brain from "lucide-static/icons/brain.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import chevronDown from "lucide-static/icons/chevron-down.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import clock from "lucide-static/icons/clock.svg?raw";
import code from "lucide-static/icons/code.svg?raw";
import copy from "lucide-static/icons/copy.svg?raw";
import download from "lucide-static/icons/download.svg?raw";
import file from "lucide-static/icons/file.svg?raw";
import fileDiff from "lucide-static/icons/file-diff.svg?raw";
import folder from "lucide-static/icons/folder.svg?raw";
import folderOpen from "lucide-static/icons/folder-open.svg?raw";
import gitBranch from "lucide-static/icons/git-branch.svg?raw";
import globe from "lucide-static/icons/globe.svg?raw";
import history from "lucide-static/icons/history.svg?raw";
import house from "lucide-static/icons/house.svg?raw";
import keyboard from "lucide-static/icons/keyboard.svg?raw";
import layers from "lucide-static/icons/layers.svg?raw";
import layoutGrid from "lucide-static/icons/layout-grid.svg?raw";
import maximize from "lucide-static/icons/square.svg?raw";
import messageCircle from "lucide-static/icons/message-circle.svg?raw";
import messageSquare from "lucide-static/icons/message-square.svg?raw";
import mic from "lucide-static/icons/mic.svg?raw";
import minus from "lucide-static/icons/minus.svg?raw";
import monitor from "lucide-static/icons/monitor.svg?raw";
import moon from "lucide-static/icons/moon.svg?raw";
import mousePointer from "lucide-static/icons/mouse-pointer-2.svg?raw";
import panelBottom from "lucide-static/icons/panel-bottom.svg?raw";
import panelLeft from "lucide-static/icons/panel-left.svg?raw";
import panelRight from "lucide-static/icons/panel-right.svg?raw";
import paperclip from "lucide-static/icons/paperclip.svg?raw";
import pictureInPicture from "lucide-static/icons/picture-in-picture-2.svg?raw";
import pin from "lucide-static/icons/pin.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import refresh from "lucide-static/icons/rotate-cw.svg?raw";
import ruler from "lucide-static/icons/ruler.svg?raw";
import scrollText from "lucide-static/icons/scroll-text.svg?raw";
import search from "lucide-static/icons/search.svg?raw";
import server from "lucide-static/icons/server.svg?raw";
import settings from "lucide-static/icons/settings.svg?raw";
import shield from "lucide-static/icons/shield-alert.svg?raw";
import slash from "lucide-static/icons/slash.svg?raw";
import sparkles from "lucide-static/icons/sparkles.svg?raw";
import sun from "lucide-static/icons/sun.svg?raw";
import terminal from "lucide-static/icons/square-terminal.svg?raw";
import x from "lucide-static/icons/x.svg?raw";

const brand = (d: string, vb = "0 0 24 24") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

export const icon = {
  activity, arrowDown, arrowLeft, arrowRight, arrowUp, atSign, bot, boxes, brain, check,
  chevronDown, chevronRight, clock, code, copy, download, file, fileDiff, folder, folderOpen,
  gitBranch, globe, history, house, keyboard, layers, layoutGrid, maximize, messageCircle,
  messageSquare, mic, minus, monitor, moon, mousePointer, panelBottom, panelLeft, panelRight,
  paperclip, pictureInPicture, pin, plus, refresh, ruler, scrollText, search, server, settings,
  shield, slash, sparkles, sun, terminal, x,
  windows: brand("M3 5.1 10.6 4v7.4H3zM11.6 3.9 21 2.5v8.9h-9.4zM3 12.4h7.6v7.5L3 18.8zM11.6 12.4H21v9l-9.4-1.3z"),
  apple: brand(
    "M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.8-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.7 2.4 3 2.4 1.2 0 1.6-.8 3.1-.8 1.4 0 1.8.8 3.1.8 1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.6-1-2.7-4.100zM14.200 5.7c.7-.8 1.100-1.900 1-3-1 .0-2.100.6-2.800 1.400-.6.7-1.200 1.800-1 2.900 1.100.1 2.200-.5 2.800-1.300z",
  ),
  github: brand(
    "M12 2a10 10 0 0 0-3.160 19.490c.5.090.680-.220.680-.480v-1.700c-2.780.6-3.370-1.340-3.370-1.340-.450-1.160-1.110-1.470-1.110-1.470-.910-.620.070-.610.070-.610 1 .070 1.530 1.030 1.530 1.030.890 1.530 2.340 1.090 2.910.830.090-.650.350-1.090.630-1.340-2.220-.250-4.550-1.110-4.550-4.940 0-1.090.390-1.980 1.030-2.680-.100-.250-.450-1.270.100-2.650 0 0 .840-.270 2.750 1.020a9.560 9.560 0 0 1 5 0c1.910-1.290 2.750-1.020 2.750-1.020.550 1.380.200 2.400.100 2.650.640.700 1.030 1.590 1.030 2.680 0 3.840-2.340 4.680-4.570 4.930.360.310.680.920.680 1.850v2.740c0 .270.180.580.690.480A10 10 0 0 0 12 2z",
  ),
} as const;

export type IconName = keyof typeof icon;

/** Inline icon wrapped so CSS can size it with `.i`. */
export const i = (name: IconName, cls = "") => `<span class="i ${cls}" aria-hidden="true">${icon[name]}</span>`;

let piSeq = 0;
/** The π mark from the app icon: one bar, a short leg and a long leg, magenta into blue. */
export function piMark(size = 28): string {
  const id = `pi-g${piSeq++}`;
  return `<svg class="pi" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
<defs><linearGradient id="${id}" x1="8" y1="6" x2="38" y2="44" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#ff4fd8"/><stop offset=".52" stop-color="#8b5cf6"/><stop offset="1" stop-color="#38b6ff"/></linearGradient></defs>
<path fill="url(#${id})" d="M6.500 8h35A1.500 1.500 0 0 1 43 9.500v6A1.500 1.500 0 0 1 41.500 17H36v24.500A1.500 1.500 0 0 1 34.500 43h-6A1.500 1.500 0 0 1 27 41.500V17h-6v15.500A1.500 1.500 0 0 1 19.500 34h-6A1.500 1.500 0 0 1 12 32.500V17H6.500A1.500 1.500 0 0 1 5 15.500v-6A1.500 1.500 0 0 1 6.500 8z"/></svg>`;
}
