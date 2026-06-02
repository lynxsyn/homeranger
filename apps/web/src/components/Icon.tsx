/**
 * Icon — a thin wrapper over lucide-react keyed by the HomeScout design's
 * kebab-case names (so ported markup reads the same as the handoff prototype).
 * Default strokeWidth 1.75 matches the design system.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import {
  Moon,
  Sun,
  ChevronUp,
  ChevronDown,
  BedDouble,
  Bath,
  ExternalLink,
  Mail,
  Rows3,
  LayoutGrid,
  ShieldCheck,
  Image as ImageIcon,
  Images,
  MapPin,
  Search,
  Pause,
  Play,
  SlidersHorizontal,
  Home,
  ArrowRight,
  Check,
  X,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  moon: Moon,
  sun: Sun,
  "chevron-up": ChevronUp,
  "chevron-down": ChevronDown,
  "bed-double": BedDouble,
  bath: Bath,
  "external-link": ExternalLink,
  mail: Mail,
  "rows-3": Rows3,
  "layout-grid": LayoutGrid,
  "shield-check": ShieldCheck,
  image: ImageIcon,
  images: Images,
  "map-pin": MapPin,
  search: Search,
  pause: Pause,
  play: Play,
  "sliders-horizontal": SlidersHorizontal,
  home: Home,
  "arrow-right": ArrowRight,
  check: Check,
  x: X,
  sparkles: Sparkles,
  "trash-2": Trash2,
};

export interface IconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 18, strokeWidth = 1.75, className }: IconProps) {
  const Glyph = ICONS[name];
  if (!Glyph) {
    return null;
  }
  return (
    <Glyph size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
  );
}
