// Each message is [English, Simplified Chinese, Traditional Chinese (Taiwan)].
const MESSAGES = {
  "wallpaper.title": ["Wallpaper", "壁纸", "桌布"],
  "wallpaper.open": ["Choose wallpaper…", "选择壁纸…", "選擇桌布…"],
  "wallpaper.close": ["Close wallpaper settings", "关闭壁纸设置", "關閉桌布設定"],
  "wallpaper.hint": ["Make the workbench yours. Changes apply automatically.", "为工作台挑选喜欢的背景，修改会自动生效。", "為工作台挑選喜歡的背景，變更會自動生效。"],
  "wallpaper.choose": ["Choose wallpaper", "选择壁纸", "選擇桌布"],
  "wallpaper.none": ["None", "无壁纸", "無桌布"],
  "wallpaper.custom": ["Custom", "自定义", "自訂"],
  "wallpaper.upload": ["Choose local file…", "选择本地文件…", "選擇本機檔案…"],
  "wallpaper.replace": ["Replace custom file…", "替换自定义文件…", "替換自訂檔案…"],
  "wallpaper.remove": ["Remove custom wallpaper", "移除自定义壁纸", "移除自訂桌布"],
  "wallpaper.fileHint": ["PNG, JPEG or WebP up to 20 MB · MP4 up to 100 MB", "PNG、JPEG、WebP 最大 20 MB · MP4 最大 100 MB", "PNG、JPEG、WebP 最大 20 MB · MP4 最大 100 MB"],
  "wallpaper.visibility": ["Visibility", "可见度", "可見度"],
  "wallpaper.blur": ["Blur", "模糊", "模糊"],
  "wallpaper.pixels": ["{value} px", "{value} 像素", "{value} 像素"],
  "wallpaper.motion": ["Play video wallpaper", "播放动态壁纸", "播放動態桌布"],
  "wallpaper.motionHint": ["Off by default. Videos stay still until enabled; reduced-motion settings are respected.", "默认关闭，开启后才播放视频；遵循系统的减少动态效果设置。", "預設關閉，開啟後才播放影片；遵循系統的減少動態效果設定。"],
  "wallpaper.saving": ["Saving wallpaper…", "正在保存壁纸…", "正在儲存桌布…"],
  "wallpaper.reset": ["Reset to default", "恢复默认", "恢復預設"],
  "wallpaper.done": ["Done", "完成", "完成"],
  "wallpaper.localOnly": ["Stored on this device only. Never uploaded.", "仅保存在本机，不会上传。", "僅儲存在本機，不會上傳。"],
  "wallpaper.builtin.night-launch": ["Night Launch", "夜航流光", "夜航流光"],
  "wallpaper.builtin.silent-orbits": ["Silent Orbits", "静谧星轨", "靜謐星軌"],
  "wallpaper.builtin.dune-dawn": ["Dune Dawn", "沙海晨光", "沙海晨光"],
  "wallpaper.builtin.planet-dawn": ["Planet Dawn", "星海晨曦", "星海晨曦"],
  "wallpaper.builtin.indigo-folds": ["Indigo Folds", "靛蓝层叠", "靛藍層疊"],
  "wallpaper.builtin.dune-sphere": ["Dune Sphere", "沙丘圆石", "沙丘圓石"],
  "wallpaper.builtin.ocean-clouds": ["Ocean Clouds", "沧海流云", "滄海流雲"],
  "wallpaper.builtin.rose-quartz": ["Rose Quartz", "蔷薇晶矿", "薔薇晶礦"],
  "wallpaper.error.unsupportedType": ["Choose a PNG, JPEG, WebP image or an MP4 video.", "请选择 PNG、JPEG、WebP 图片或 MP4 视频。", "請選擇 PNG、JPEG、WebP 圖片或 MP4 影片。"],
  "wallpaper.error.imageTooLarge": ["The image must be 20 MB or smaller.", "图片不能超过 20 MB。", "圖片不能超過 20 MB。"],
  "wallpaper.error.videoTooLarge": ["The video must be 100 MB or smaller.", "视频不能超过 100 MB。", "影片不能超過 100 MB。"],
  "wallpaper.error.invalidFile": ["This file is empty, damaged or does not match its format. Choose another file.", "文件为空、已损坏或与格式不符，请选择其他文件。", "檔案為空、已損壞或與格式不符，請選擇其他檔案。"],
  "wallpaper.error.decode": ["This image or video cannot be displayed. Try another file or video encoding.", "无法显示此图片或视频，请更换文件或视频编码。", "無法顯示此圖片或影片，請更換檔案或影片編碼。"],
  "wallpaper.error.playback": ["The video could not play. Try another MP4 file or leave motion turned off.", "视频无法播放，请尝试其他 MP4 文件或关闭动态播放。", "影片無法播放，請嘗試其他 MP4 檔案或關閉動態播放。"],
  "wallpaper.error.storage": ["Could not save or load the local wallpaper. Check available storage and try again.", "无法保存或读取本地壁纸，请检查存储空间后重试。", "無法儲存或讀取本機桌布，請檢查儲存空間後重試。"],
  "wallpaper.error.settings": ["Could not save wallpaper settings. Please try again.", "无法保存壁纸设置，请重试。", "無法儲存桌布設定，請重試。"],
  "wallpaper.error.unknownId": ["This wallpaper is unavailable. Choose another one.", "此壁纸不可用，请重新选择。", "此桌布無法使用，請重新選擇。"],
  "wallpaper.error.customMissing": ["The custom wallpaper is missing. Choose a local file again.", "自定义壁纸已丢失，请重新选择本地文件。", "自訂桌布已遺失，請重新選擇本機檔案。"],
};

const catalog = (index) => Object.freeze(Object.fromEntries(
  Object.entries(MESSAGES).map(([key, values]) => [key, values[index]]),
));
export const wallpaperEn = catalog(0);
export const wallpaperZhCN = catalog(1);
export const wallpaperZhTW = catalog(2);
