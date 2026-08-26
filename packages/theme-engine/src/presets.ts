/**
 * Academic preset palettes. Roles are semantic: swapping a theme re-colors a
 * figure without touching layout, text or structure (PRD §43 Theme 验收).
 * Colors are #RRGGBB.
 */

export interface ThemeRoles {
  primary: string
  secondary: string
  accent: string
  background: string
  surface: string
  textPrimary: string
  textSecondary: string
  border: string
  connector: string
}

export interface ResearchTheme {
  id: string
  name: string
  roles: ThemeRoles
}

export const PRESET_THEMES: readonly ResearchTheme[] = [
  {
    id: 'academic-blue',
    name: 'Academic Blue',
    roles: {
      primary: '#24527A',
      secondary: '#7395B5',
      accent: '#D68A45',
      background: '#F7F8FA',
      surface: '#FFFFFF',
      textPrimary: '#17212B',
      textSecondary: '#66717B',
      border: '#C8D0D8',
      connector: '#687784',
    },
  },
  {
    id: 'academic-green',
    name: 'Academic Green',
    roles: {
      primary: '#2F6B4F',
      secondary: '#7FA88F',
      accent: '#C97B4A',
      background: '#F7FAF8',
      surface: '#FFFFFF',
      textPrimary: '#1B2420',
      textSecondary: '#66746C',
      border: '#CBD8CF',
      connector: '#6B7A70',
    },
  },
  {
    id: 'wine-red',
    name: 'Wine Red',
    roles: {
      primary: '#7A2E45',
      secondary: '#B08A96',
      accent: '#3E6B8A',
      background: '#FBF7F8',
      surface: '#FFFFFF',
      textPrimary: '#241A1E',
      textSecondary: '#75666C',
      border: '#D8C8CE',
      connector: '#7A6B71',
    },
  },
  {
    id: 'purple-gray',
    name: 'Purple Gray',
    roles: {
      primary: '#5B4A73',
      secondary: '#9A8CAD',
      accent: '#C2884E',
      background: '#F8F7FA',
      surface: '#FFFFFF',
      textPrimary: '#211D28',
      textSecondary: '#6C6775',
      border: '#D0CBD8',
      connector: '#716C7D',
    },
  },
  {
    id: 'neutral-gray',
    name: 'Neutral Gray',
    roles: {
      primary: '#4A5258',
      secondary: '#93A0A8',
      accent: '#C4763B',
      background: '#F8F9F9',
      surface: '#FFFFFF',
      textPrimary: '#1F2326',
      textSecondary: '#69727A',
      border: '#CFD6DA',
      connector: '#6E767D',
    },
  },
  {
    id: 'black-accent',
    name: 'Black + Accent',
    roles: {
      primary: '#22262A',
      secondary: '#8A9096',
      accent: '#E0592A',
      background: '#FAFAFA',
      surface: '#FFFFFF',
      textPrimary: '#141618',
      textSecondary: '#63686D',
      border: '#CCD0D3',
      connector: '#5F6468',
    },
  },
  {
    id: 'ai-cyan',
    name: 'AI Cyan',
    roles: {
      primary: '#14657B',
      secondary: '#6FA8BC',
      accent: '#E0913F',
      background: '#F5FAFC',
      surface: '#FFFFFF',
      textPrimary: '#152227',
      textSecondary: '#5F7079',
      border: '#C6DBE2',
      connector: '#65787F',
    },
  },
  {
    id: 'warm-humanities',
    name: 'Warm Humanities',
    roles: {
      primary: '#8A5A2E',
      secondary: '#C0A183',
      accent: '#4E6E58',
      background: '#FBF8F3',
      surface: '#FFFDF9',
      textPrimary: '#26201A',
      textSecondary: '#75695B',
      border: '#DED2C0',
      connector: '#7D7163',
    },
  },
  {
    id: 'nature-light',
    name: 'Nature Light',
    roles: {
      primary: '#3C5A94',
      secondary: '#8CA3C8',
      accent: '#C25B4E',
      background: '#FCFCFD',
      surface: '#FFFFFF',
      textPrimary: '#1A1F2A',
      textSecondary: '#646B78',
      border: '#D3D8E2',
      connector: '#6A7280',
    },
  },
  {
    id: 'dark-academic',
    name: 'Dark Academic',
    roles: {
      primary: '#7EB3E3',
      secondary: '#4E7196',
      accent: '#E8A45C',
      background: '#161C24',
      surface: '#1E2632',
      textPrimary: '#EDF1F6',
      textSecondary: '#9AA7B5',
      border: '#33404F',
      connector: '#8494A5',
    },
  },
] as const

export function getThemeById(id: string): ResearchTheme | undefined {
  return PRESET_THEMES.find((t) => t.id === id)
}
