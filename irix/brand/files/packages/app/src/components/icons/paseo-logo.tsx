import Svg, { Circle, Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";
import {
  IRIX_LOGO_EYES,
  IRIX_LOGO_STROKE_PATHS,
  IRIX_LOGO_STROKE_WIDTH,
  IRIX_LOGO_VIEWBOX,
} from "./irix-logo-geometry";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

// Internal edition: draws the Irix mark. The component keeps its upstream name so
// call sites stay untouched across upstream merges.
export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const stroke = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox={IRIX_LOGO_VIEWBOX} fill="none">
      {IRIX_LOGO_STROKE_PATHS.map((d) => (
        <Path
          key={d}
          d={d}
          fill={stroke}
          stroke={stroke}
          strokeWidth={IRIX_LOGO_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {IRIX_LOGO_EYES.map((eye) => (
        <Circle key={`${eye.cx}-${eye.cy}`} cx={eye.cx} cy={eye.cy} r={eye.r} fill={stroke} />
      ))}
    </Svg>
  );
}
