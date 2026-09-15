/**
 * Political name filter for real-world maps: player-visible names (map, POI and landmark labels) never name political
 * figures, political events or dates, party or state organs, or their memorials. OSM names that match are not used;
 * the POI namer falls back to the next named thing nearby or a generic word.
 *
 * Matching ignores case, diacritics and punctuation, and only matches whole words ("Công an" but not "Công ty An").
 * Historical kings, generals and scholars (Đinh Tiên Hoàng, Lê Văn Duyệt, Chu Văn An) are deliberately not listed.
 */

/** Lowercase ASCII words separated by single spaces: "Uỷ Ban Nhân Dân" → "uy ban nhan dan". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Political figures and revolutionaries. */
const FIGURES = [
  "Hồ Chí Minh", "Nguyễn Ái Quốc", "Nguyễn Tất Thành", "Phan Đăng Lưu", "Nguyễn Văn Trỗi", "Hoàng Văn Thụ", "Nguyễn Thị Minh Khai",
  "Võ Thị Sáu", "Lê Duẩn", "Tôn Đức Thắng", "Trường Chinh", "Phạm Văn Đồng", "Võ Nguyên Giáp", "Lê Đức Thọ", "Nguyễn Văn Linh",
  "Đỗ Mười", "Lê Khả Phiêu", "Nông Đức Mạnh", "Nguyễn Phú Trọng", "Trần Phú", "Hà Huy Tập", "Lê Hồng Phong", "Nguyễn Văn Cừ",
  "Lý Tự Trọng", "Nguyễn Hữu Thọ", "Huỳnh Tấn Phát", "Nguyễn Thị Định", "Phạm Hùng", "Võ Văn Kiệt", "Nguyễn Chí Thanh",
  "Lê Trọng Tấn", "Hoàng Quốc Việt", "Nguyễn Đức Cảnh", "Nguyễn Lương Bằng", "Châu Văn Liêm", "Ung Văn Khiêm", "Trần Văn Giàu",
  "Nguyễn An Ninh", "Phan Bội Châu", "Phan Chu Trinh", "Phan Châu Trinh", "Nguyễn Thái Học", "Trần Huy Liệu", "Lê Văn Sỹ",
  "Nguyễn Kiệm", "Huỳnh Văn Bánh", "Nguyễn Trọng Tuyển", "Phạm Viết Chánh", "Hồ Văn Huê", "Lê Văn Tám", "Nguyễn Văn Nguyễn",
  "Võ Chí Công", "Phùng Văn Cung", "Trần Bạch Đằng", "Lê Đức Anh", "Nguyễn Thị Thập", "Hoàng Minh Giám", "Lê Quang Đạo",
  "Nguyễn Duy Trinh", "Lê Thanh Nghị", "Trần Đức Lương", "Phan Văn Khải", "Nguyễn Minh Triết", "Trương Tấn Sang", "Nguyễn Tấn Dũng",
  "Karl Marx", "Các Mác", "Lenin", "Lênin", "Lê Nin", "Stalin",
];

/** Political events, slogans and their monuments. */
const EVENTS = [
  "Xô Viết", "Điện Biên", "Cách Mạng", "Tháng Tám", "Khởi Nghĩa", "Đồng Khởi", "Mậu Thân", "Giải Phóng", "Kháng Chiến",
  "Dinh Độc Lập", "Hội trường Thống Nhất", "Liệt sĩ", "Liệt sỹ", "Tưởng niệm", "Tượng đài", "Chứng tích", "War Memorial",
];

/** Party and state organs, security forces and their schools. */
const ORGANS = [
  "Ủy ban", "UBND", "HĐND", "Hội đồng nhân dân", "People's Committee", "Đảng ủy", "Đảng bộ", "Thành ủy", "Quận ủy", "Huyện ủy",
  "Tỉnh ủy", "Cộng sản", "Communist", "Mặt trận Tổ quốc", "MTTQ", "Công an", "CSGT", "Cảnh sát", "Police", "Quân đội", "Quân khu",
  "Quân đoàn", "Bộ Tư lệnh", "Chỉ huy Quân sự", "Bộ đội", "Biên phòng", "Military", "Army", "Cựu chiến binh", "Chính trị",
  "Đoàn Thanh niên", "Hội Liên hiệp Phụ nữ", "Liên đoàn Lao động", "Viện Kiểm sát", "Tòa án", "Toà án",
];

/** City names that carry a political figure's name ("TP.HCM", "HCMC"); player-visible text says "Sài Gòn". */
const CITY = ["HCM", "TPHCM", "HCMC"];

const PHRASES = [...new Set([...FIGURES, ...EVENTS, ...ORGANS, ...CITY].map(normalizeName))];
/** Political dates as street or place names: "30 Tháng 4", "3/2", "Cách Mạng Tháng 8". */
const DATES = ["30 4", "3 2", "2 9", "19 5", "1 5", "19 8", "26 3", "22 12", "27 7", "23 9", "7 5", "23 11"];
const DATE_WORDS = new RegExp(`(?:^| )(?:${DATES.map((d) => d.replace(" ", " thang ")).join("|")})(?: |$)`);
const DATE_SLASH = new RegExp(`(?:^|[^\\d/])(?:${DATES.map((d) => d.replace(" ", "/")).join("|")})(?![\\d/])`);

/** True when a name refers to a political figure, event, date, organ or memorial and must not label the map. */
export function isPoliticalName(name: string): boolean {
  const words = ` ${normalizeName(name)} `;
  if (PHRASES.some((phrase) => words.includes(` ${phrase} `))) return true;
  return DATE_WORDS.test(words.trim()) || DATE_SLASH.test(name);
}
