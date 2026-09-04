/** Insert controls included in the slides ribbon's Home tab. */
import { ICON_COLORS, ICON_GALLERY } from '../insert-presets'
import { Icon3d, IconEquation, IconIconLib, IconPicture, IconTable, IconTextBox } from './icons'
import { BIG, Group, closeSiblingPanels, type RibbonTabCtx } from './ribbon-shared'

export function RibbonInsertTab({ rb }: { rb: RibbonTabCtx }) {
  const {
    closePanels,
    hasDoc,
    iconColor,
    onInsert,
    onInsertIcon,
    onInsertImage,
    onInsertModel3d,
    onInsertTable,
    onOpenEquation,
    setIconColor,
    setInsertDrop,
    setTableCustom,
    setTableHover,
    setTableOpen,
    tableCustom,
    tableHover,
    tableOpen,
    t,
    dropBig,
  } = rb

  return (
    <>
      <div className="ribbon-sep" />
      <Group label={t('ribbonGroupTable')}>
        <div className="rb-drop-wrap">
          <button
            className={`rb-big ${tableOpen ? 'active' : ''}`}
            disabled={!hasDoc}
            data-tip={t('ribbonInsertTableTip')}
            onMouseDown={(e) => {
              e.stopPropagation()
              closeSiblingPanels(e, closePanels, 'table')
            }}
            onClick={() => setTableOpen((v) => !v)}
          >
            <span className="rb-big-icon">
              <IconTable size={BIG} />
            </span>
            <span>{t('ribbonGroupTable')}</span>
          </button>
          {tableOpen && (
            <div className="rb-drop rb-table-picker" onMouseDown={(e) => e.stopPropagation()}>
              <div className="rb-table-picker-label">
                {tableHover.r > 0
                  ? t('ribbonTableSize', { r: tableHover.r, c: tableHover.c })
                  : t('ribbonTablePickerHint')}
              </div>
              <div className="rb-table-grid" onMouseLeave={() => setTableHover({ r: 0, c: 0 })}>
                {Array.from({ length: 8 }, (_, r) =>
                  Array.from({ length: 10 }, (_, c) => (
                    <button
                      key={`${r}-${c}`}
                      className={`rb-table-cell ${r < tableHover.r && c < tableHover.c ? 'on' : ''}`}
                      onMouseEnter={() => setTableHover({ r: r + 1, c: c + 1 })}
                      onClick={() => {
                        setTableOpen(false)
                        onInsertTable(r + 1, c + 1)
                      }}
                    />
                  )),
                )}
              </div>
              <div className="rb-table-custom">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={tableCustom.r}
                  onChange={(e) =>
                    setTableCustom((v) => ({
                      ...v,
                      r: Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                    }))
                  }
                />
                <span>×</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={tableCustom.c}
                  onChange={(e) =>
                    setTableCustom((v) => ({
                      ...v,
                      c: Math.max(1, Math.min(50, Number(e.target.value) || 1)),
                    }))
                  }
                />
                <button
                  className="rb-table-custom-ok"
                  onClick={() => {
                    setTableOpen(false)
                    onInsertTable(tableCustom.r, tableCustom.c)
                  }}
                >
                  {t('paneOk')}
                </button>
              </div>
            </div>
          )}
        </div>
      </Group>
      <div className="ribbon-sep" />
      <Group label={t('ribbonGroupImages')}>
        <button
          className="rb-big"
          disabled={!hasDoc}
          onClick={onInsertImage}
          data-tip={t('ribbonPictureTip')}
        >
          <span className="rb-big-icon">
            <IconPicture size={BIG} />
          </span>
          <span>{t('ribbonPicture')}</span>
        </button>
        {dropBig(
          'icons',
          <IconIconLib size={BIG} />,
          t('ribbonIcons'),
          t('ribbonIconsTip'),
          <div className="rb-icon-gallery">
            <div className="rb-icon-colors">
              {ICON_COLORS.map((c) => (
                <button
                  key={c}
                  className={`rb-swatch ${iconColor === c ? 'on' : ''}`}
                  style={{ background: c }}
                  data-tip={c}
                  aria-label={c}
                  onClick={() => setIconColor(c)}
                />
              ))}
            </div>
            <div className="rb-icon-grid">
              {ICON_GALLERY.map((def) => (
                <button
                  key={def.name}
                  className="rb-icon-cell"
                  data-tip={def.name}
                  aria-label={def.name}
                  onClick={() => {
                    setInsertDrop(null)
                    onInsertIcon(def, iconColor)
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width={22}
                    height={22}
                    fill="none"
                    stroke={iconColor}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dangerouslySetInnerHTML={{ __html: def.body }}
                  />
                </button>
              ))}
            </div>
          </div>,
        )}
        <button
          className="rb-big"
          disabled={!hasDoc}
          onClick={onInsertModel3d}
          data-tip={t('ribbon3dModelTip')}
        >
          <span className="rb-big-icon">
            <Icon3d size={BIG} />
          </span>
          <span>{t('ribbon3dModel')}</span>
        </button>
      </Group>
      <Group label={t('ribbonShapeGroupText')}>
        <button
          className="rb-big"
          disabled={!hasDoc}
          onClick={() => onInsert('textbox')}
          data-tip={t('ribbonInsertTextBoxTip')}
        >
          <span className="rb-big-icon">
            <IconTextBox size={BIG} />
          </span>
          <span>{t('ribbonTextBox')}</span>
        </button>
      </Group>
      <div className="ribbon-sep" />
      <Group label={t('ribbonGroupSymbols')}>
        <button
          className="rb-big"
          disabled={!hasDoc}
          onClick={onOpenEquation}
          data-tip={t('ribbonEquationTip')}
        >
          <span className="rb-big-icon">
            <IconEquation size={BIG} />
          </span>
          <span>{t('ribbonEquation')}</span>
        </button>
      </Group>
    </>
  )
}
