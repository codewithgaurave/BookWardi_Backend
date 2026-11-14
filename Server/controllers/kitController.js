import Kit from "../models/Kit.js";

// Browse all available Kit Bundles (with filters: School, Gender, Class, Tag)
export const getKits = async (req, res) => {
  try {
    const { schoolName, gender, classGrade, badgeTag, search, sellerId } = req.query;
    const filter = {
      status: { $nin: ["deleted", "inactive"] },
      isDeleted: { $ne: true },
      approvalStatus: { $in: ["Approved", "approved"] },
      isApproved: { $ne: false }
    };

    const andConditions = [];

    if (schoolName && schoolName.trim()) {
      const schStr = schoolName.trim();
      const isAllReq = ["all", "all schools", "any", "any school", "general"].includes(schStr.toLowerCase());
      if (!isAllReq) {
        andConditions.push({
          $or: [
            { schoolName: { $regex: schStr, $options: "i" } },
            { schoolName: { $regex: "all school|open for all|general", $options: "i" } },
            { schoolCode: { $in: ["ALL", "GEN", "ALL-SCHOOLS"] } }
          ]
        });
      }
    }

    if (gender && gender !== "All") {
      andConditions.push({
        $or: [
          { gender: gender },
          { gender: { $in: ["Unisex", "All"] } }
        ]
      });
    }

    if (classGrade && classGrade.trim()) {
      const clsStr = classGrade.trim();
      const isAllCls = ["all", "all classes", "all grades", "any class"].includes(clsStr.toLowerCase());
      if (!isAllCls) {
        andConditions.push({
          $or: [
            { classGrade: { $regex: clsStr, $options: "i" } },
            { classGrade: { $regex: "all class|all grade|all", $options: "i" } }
          ]
        });
      }
    }

    if (badgeTag) filter.badgeTag = badgeTag;
    if (sellerId) filter.sellerId = sellerId;

    if (search && search.trim()) {
      const q = search.trim();
      andConditions.push({
        $or: [
          { title: { $regex: q, $options: "i" } },
          { schoolName: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
          { "items.name": { $regex: q, $options: "i" } }
        ]
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

// Helper to enrich kit items with available sizes from constituent products
const enrichKitSizes = (kitObj) => {
  if (!kitObj) return kitObj;
  const k = kitObj.toObject ? kitObj.toObject() : { ...kitObj };
  const allSizesSet = new Set(Array.isArray(k.sizes) ? k.sizes : (Array.isArray(k.availableSizes) ? k.availableSizes : []));

  if (Array.isArray(k.items)) {
    k.items = k.items.map((item) => {
      const it = item.toObject ? item.toObject() : { ...item };
      let sizes = Array.isArray(it.availableSizes) && it.availableSizes.length > 0 ? [...it.availableSizes] : [];

      if (sizes.length === 0 && it.productId && typeof it.productId === "object") {
        if (Array.isArray(it.productId.sizes) && it.productId.sizes.length > 0) {
          sizes = it.productId.sizes;
        } else if (Array.isArray(it.productId.sizeVariants) && it.productId.sizeVariants.length > 0) {
          sizes = it.productId.sizeVariants
            .map((v) => (typeof v === "object" ? v.size || v.measureValue : v))
            .filter(Boolean);
        }
      }

      // Check item name for sizes like (22), (24), etc.
      if (sizes.length === 0) {
        const match = (it.name || "").match(/\b(1[6-8]|2[0-9]|3[0-9]|4[0-4]|XS|S|M|L|XL|2XL|3XL)\b/i);
        const baseNum = parseInt(match ? match[1] : it.size);
        if (!isNaN(baseNum) && baseNum >= 18 && baseNum <= 42) {
          sizes = ["20", "22", "24", "26", "28", "30", "32", "34", "36"].filter(
            (s) => Math.abs(parseInt(s) - baseNum) <= 8
          );
        } else if (it.size && it.size.trim()) {
          sizes = [it.size.trim()];
        }
      }

      sizes.forEach((s) => allSizesSet.add(String(s).trim()));
      return {
        ...it,
        availableSizes: sizes
      };
    });
  }

  const combinedSizes = Array.from(allSizesSet).filter(Boolean);
  k.availableSizes = combinedSizes;
  if (!Array.isArray(k.sizes) || k.sizes.length === 0) {
    k.sizes = combinedSizes;
  }
  return k;
};

    const kits = await Kit.find(filter)
      .populate("sellerId", "storeName name city phone")
      .populate("items.productId", "name price images image category stock stockQuantity sizes sizeVariants sku")
      .sort({ createdAt: -1 });

    const enrichedKits = kits.map(enrichKitSizes);

    res.json({
      count: enrichedKits.length,
      kits: enrichedKits
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch kits", error: error.message });
  }
};

// Get single Kit Bundle details by ID
export const getKitById = async (req, res) => {
  try {
    const kit = await Kit.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
      status: { $nin: ["deleted", "inactive"] },
      approvalStatus: { $in: ["Approved", "approved"] },
      isApproved: { $ne: false }
    })
      .populate("sellerId", "storeName name city phone location")
      .populate("items.productId", "name price images image category stock stockQuantity sizes sizeVariants sku");

    if (!kit) {
      return res.status(404).json({ message: "Kit bundle not found or is awaiting approval" });
    }

    res.json(enrichKitSizes(kit));
  } catch (error) {
    res.status(404).json({ message: "Kit bundle not found or is awaiting approval", error: error.message });
  }
};
