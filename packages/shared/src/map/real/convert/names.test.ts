import { describe, expect, it } from "vitest";
import { isPoliticalName, normalizeName } from "./names";

describe("political name filter", () => {
  it("normalizes case, diacritics, đ and punctuation", () => {
    expect(normalizeName("Uỷ Ban Nhân Dân Phường 2")).toBe("uy ban nhan dan phuong 2");
    expect(normalizeName("Đường Điện Biên Phủ")).toBe("duong dien bien phu");
    expect(normalizeName("TP.HCM")).toBe("tp hcm");
  });

  it("flags political figures, with or without diacritics", () => {
    for (const name of ["Phan Đăng Lưu", "Hẻm 181/7 Phan Đăng Lưu", "PHAN DANG LUU", "Trường THPT Nguyễn Thị Minh Khai", "Võ Thị Sáu", "Lê Duẩn", "Tôn Đức Thắng", "Hoàng Văn Thụ", "Nguyễn Văn Trỗi", "Trường THCS Châu Văn Liêm"]) {
      expect(isPoliticalName(name), name).toBe(true);
    }
  });

  it("flags events, dates, organs and memorials", () => {
    for (const name of ["Xô Viết Nghệ Tĩnh", "Xô viết Nghệ Tĩnh", "Điện Biên Phủ", "Đường 30 Tháng 4", "3 tháng 2", "Đường 3/2", "Cách Mạng Tháng Tám", "Ủy ban nhân dân phường Cầu Kiệu", "Uỷ Ban Nhân Dân Phường 5", "UBND Phường 24", "Công An Phường 24", "Đảng ủy phường", "Mặt trận Tổ quốc", "Bộ Tư lệnh Quân khu 7", "Hội Cựu chiến binh", "Trường Chính trị", "Nghĩa trang Liệt sĩ", "Tượng đài Chiến thắng"]) {
      expect(isPoliticalName(name), name).toBe(true);
    }
  });

  it("flags the city name that carries a political figure's name", () => {
    for (const name of ["Trường Đại học Công nghệ Thành phố Hồ Chí Minh", "Trường CĐ Kinh Tế Đối Ngoại TP.HCM", "HCMC Tower", "Ho Chi Minh Mausoleum"]) {
      expect(isPoliticalName(name), name).toBe(true);
    }
  });

  it("keeps neutral names, historical kings and scholars, and look-alike words", () => {
    for (const name of ["Chung cư Mỹ Đức", "Chùa Phước Viên", "Nhà Thờ Hàng Xanh", "Ngã Tư Hàng Xanh", "Rạch Văn Thánh", "Cầu Sơn", "Phú Nhuận", "Sài Gòn", "Đinh Tiên Hoàng", "Lăng Lê Văn Duyệt", "Trường Chu Văn An", "Công ty An Phát", "Holašovice", "荻町", "Khu phố 43", "220/9/43", "Hẻm 13/2", "Cẩm Thanh (Bắc)"]) {
      expect(isPoliticalName(name), name).toBe(false);
    }
  });
});
